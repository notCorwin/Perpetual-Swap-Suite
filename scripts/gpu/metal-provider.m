#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <objc/runtime.h>
#include <mach/mach_time.h>
#include <mach-o/dyld.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/event.h>
#include <time.h>
#include <fcntl.h>
#include <unistd.h>
#include <limits.h>
#include <errno.h>
#include <stdbool.h>
#include <stdatomic.h>

static IMP originalCommit;
static Class hookedClass;
static double admissionEndTime;
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static int journal = -1, controlFD = -1;
static pthread_cond_t stateChanged = PTHREAD_COND_INITIALIZER;
static bool controlReady = false, controlFailed = false, captureStopped = false;
static char controlToken[33];
static _Atomic(unsigned) warningCount;
static void closeLocked(const char *reason);
static bool accepting = true, closed = false, capReported = false;
static unsigned long long observed, admitted, completed, active, rejected, errors, observerErrors, writeFailures;
static unsigned long long bytesWritten, recordsWritten, reservedBytes, maxBytes = 1024*1024, maxRecords = 4096;
static mach_timebase_info_data_t timebase;
static const unsigned long long endReserve = 768, finalReserve = 2048;
static double hostTime(void) { return (double)mach_absolute_time() * timebase.numer / timebase.denom / 1e9; }
static unsigned long long setting(const char *name, unsigned long long fallback, unsigned long long min, unsigned long long max) {
  const char *value = getenv(name); if (!value || !*value) return fallback;
  char *tail; errno = 0; unsigned long long parsed = strtoull(value, &tail, 10);
  return errno || *tail || parsed < min || parsed > max ? 0 : parsed;
}
static bool tokenValid(const char *value) {
  if (!value || strlen(value) != 32) return false;
  for (int i=0;i<32;i++) if (!((value[i]>='0' && value[i]<='9') || (value[i]>='a' && value[i]<='f'))) return false;
  return true;
}
static void warning(const char *reason) { if(atomic_fetch_add(&warningCount,1)>=16)return; dprintf(STDERR_FILENO, "PERP_METAL_DIAGNOSTIC {\"pid\":%d,\"reason\":\"%s\"}\n", getpid(), reason); }
// Call with mutex held. Capacity for admitted completion records and one final health record is reserved before commit.
static bool line(const char *value, int size) {
  if (closed || journal < 0 || size <= 0 || size >= 1024 || bytesWritten + size > maxBytes || recordsWritten >= maxRecords) { writeFailures++; accepting=false; warning("journal-capacity-or-state-failure"); return false; }
  int offset=0;
  while (offset<size) {
    ssize_t written=write(journal,value+offset,size-offset);
    if (written<0 && errno==EINTR) continue;
    if (written<=0) { writeFailures++; accepting=false; warning("journal-write-failure"); return false; }
    offset += written; bytesWritten += written;
  }
  recordsWritten++; return true;
}
static void unavailable(const char *reason) {
  char out[1024]; int length=snprintf(out,sizeof(out),"{\"kind\":\"capability\",\"enabled\":false,\"reason\":\"%s\",\"hostTime\":%.9f}\n",reason,hostTime());
  pthread_mutex_lock(&mutex); line(out,length); accepting=false; pthread_mutex_unlock(&mutex);
}
static void finish(unsigned long long sequence, double commitTime, id<MTLCommandBuffer> buffer, const char *phase) {
  double start=buffer ? buffer.GPUStartTime : 0, end=buffer ? buffer.GPUEndTime : 0;
  unsigned long status=buffer ? buffer.status : 0; long code=buffer.error ? buffer.error.code : 0;
  pthread_mutex_lock(&mutex);
  active--; completed++; reservedBytes -= endReserve;
  if (status!=MTLCommandBufferStatusCompleted || phase) errors++;
  char out[1024]; int length=snprintf(out,sizeof(out),"{\"kind\":\"complete\",\"sequence\":%llu,\"commitHostTime\":%.9f,\"completedHostTime\":%.9f,\"gpuStartTime\":%.9f,\"gpuEndTime\":%.9f,\"status\":%lu,\"errorCode\":%ld,\"phase\":\"%s\"}\n",sequence,commitTime,hostTime(),start,end,status,code,phase ? phase : "completion");
  line(out,length); pthread_cond_broadcast(&stateChanged); pthread_mutex_unlock(&mutex);
}
static void observedCommit(id<MTLCommandBuffer> buffer, SEL selector) {
  unsigned long long sequence=0; double commitTime=hostTime();
  pthread_mutex_lock(&mutex);
  if(captureStopped || closed) { pthread_mutex_unlock(&mutex); ((void (*)(id,SEL))originalCommit)(buffer,selector); return; }
  observed++;
  char out[1024]; int length=snprintf(out,sizeof(out),"{\"kind\":\"commit\",\"sequence\":%llu,\"hostTime\":%.9f}\n",admitted+1,commitTime);
  if (accepting && bytesWritten+reservedBytes+length+endReserve+finalReserve<=maxBytes && recordsWritten+active+4<=maxRecords) {
    if (line(out,length)) { sequence=++admitted; active++; reservedBytes+=endReserve; }
  }
  if (!sequence) {
    rejected++;
    if (accepting) accepting=false;
    if (!capReported && !writeFailures) { capReported=true; int size=snprintf(out,sizeof(out),"{\"kind\":\"limit\",\"hostTime\":%.9f,\"reason\":\"record-or-byte-admission-cap\"}\n",hostTime()); line(out,size); }
  }
  pthread_mutex_unlock(&mutex);
  if (sequence) {
    @try { [buffer addCompletedHandler:^(id<MTLCommandBuffer> completedBuffer) { @autoreleasepool { finish(sequence,commitTime,completedBuffer,NULL); } }]; }
    @catch (NSException *exception) { (void)exception; pthread_mutex_lock(&mutex); observerErrors++; pthread_mutex_unlock(&mutex); finish(sequence,commitTime,nil,"observer-callback-install-failure"); }
  }
  // Native exceptions are preserved. A begin without a completion remains explicit/incomplete rather than being fabricated successful.
  ((void (*)(id,SEL))originalCommit)(buffer,selector);
}
static void *controlWorker(void *unused) {
  (void)unused;
  int queue=kqueue(); struct kevent change, event;
  EV_SET(&change,controlFD,EVFILT_VNODE,EV_ADD|EV_ENABLE|EV_CLEAR,NOTE_WRITE|NOTE_DELETE|NOTE_RENAME|NOTE_REVOKE,0,NULL);
  bool ready=queue>=0 && kevent(queue,&change,1,NULL,0,NULL)==0;
  pthread_mutex_lock(&mutex); controlFailed=!ready; controlReady=true; pthread_cond_broadcast(&stateChanged); pthread_mutex_unlock(&mutex);
  if(!ready) { if(queue>=0)close(queue); return NULL; }
  for(;;) {
    int count=kevent(queue,NULL,0,&event,1,NULL);
    if(count<0 && errno==EINTR)continue;
    if(count<=0 || event.flags&EV_ERROR || event.fflags&(NOTE_DELETE|NOTE_RENAME|NOTE_REVOKE)) {
      pthread_mutex_lock(&mutex); observerErrors++; captureStopped=true; closeLocked("control-channel-failure"); pthread_mutex_unlock(&mutex); break;
    }
    char request[34]; struct stat info;
    ssize_t size=pread(controlFD,request,sizeof(request),0);
    if(fstat(controlFD,&info) || size!=33 || info.st_size!=33 || memcmp(request,controlToken,32) || request[32]!='\n')continue;
    pthread_mutex_lock(&mutex); captureStopped=true; accepting=false; admissionEndTime=hostTime();
    struct timespec deadline; clock_gettime(CLOCK_REALTIME,&deadline); deadline.tv_sec+=5;
    while(active && !closed) { if(pthread_cond_timedwait(&stateChanged,&mutex,&deadline)==ETIMEDOUT)break; }
    closeLocked("capture-window-stop"); pthread_mutex_unlock(&mutex); break;
  }
  close(queue); close(controlFD); return NULL;
}
__attribute__((constructor)) static void initialize(void) {
  @autoreleasepool {
    const char *directory=getenv("PERP_METAL_DIAGNOSTIC_DIR"), *token=getenv("PERP_METAL_DIAGNOSTIC_TOKEN"), *root=getenv("PERP_METAL_DIAGNOSTIC_EXECUTABLE_ROOT");
    if (!directory || !token || !root) return; // Explicit opt-in only.
    if (!tokenValid(token)) { warning("invalid-token"); return; }
    mach_timebase_info(&timebase);
    char resolvedRoot[PATH_MAX], executable[PATH_MAX], resolvedExecutable[PATH_MAX]; uint32_t size=sizeof(executable);
    if (!realpath(root,resolvedRoot) || _NSGetExecutablePath(executable,&size) || !realpath(executable,resolvedExecutable)
      || strncmp(resolvedRoot,resolvedExecutable,strlen(resolvedRoot)) || resolvedExecutable[strlen(resolvedRoot)]!='/') { warning("executable-outside-owned-diagnostic-root"); return; }
    struct stat info;
    if (lstat(directory,&info) || !S_ISDIR(info.st_mode) || info.st_uid!=geteuid() || (info.st_mode&0077)) { warning("private-directory-required"); return; }
    int folder=open(directory,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
    struct stat opened;
    if (folder<0 || fstat(folder,&opened) || opened.st_ino!=info.st_ino || opened.st_dev!=info.st_dev) { if(folder>=0)close(folder); warning("directory-identity-changed"); return; }
    unsigned long long slots=setting("PERP_METAL_DIAGNOSTIC_MAX_PROCESSES",8,1,32);
    maxBytes=setting("PERP_METAL_DIAGNOSTIC_MAX_BYTES",1024*1024,4096,16*1024*1024);
    maxRecords=setting("PERP_METAL_DIAGNOSTIC_MAX_RECORDS",4096,8,65536);
    if (!slots || !maxBytes || !maxRecords) { close(folder); warning("invalid-budget"); return; }
    controlFD=openat(folder,"stop.request",O_RDONLY|O_NOFOLLOW);
    struct stat controlInfo;
    if(controlFD<0 || fstat(controlFD,&controlInfo) || !S_ISREG(controlInfo.st_mode) || controlInfo.st_uid!=geteuid() || (controlInfo.st_mode&0077) || controlInfo.st_size!=0) {
      close(folder); if(controlFD>=0)close(controlFD); warning("private-empty-stop-control-required"); return;
    }
    memcpy(controlToken,token,33);
    for (unsigned index=0;index<slots;index++) {
      char name[64]; snprintf(name,sizeof(name),"metal-slot-%u.jsonl",index);
      journal=openat(folder,name,O_WRONLY|O_APPEND|O_CREAT|O_EXCL|O_NOFOLLOW,0600);
      if(journal>=0)break;
      if(errno!=EEXIST) { close(folder); warning("journal-create-failure"); return; }
    }
    close(folder);
    if(journal<0) { close(controlFD); warning("process-admission-cap"); return; }
    char out[1024]; int length=snprintf(out,sizeof(out),"{\"kind\":\"loader\",\"schemaVersion\":1,\"provider\":\"metal-command-buffer\",\"source\":\"native\",\"measurement\":\"device-clock\",\"clock\":\"metal-host-monotonic-seconds\",\"pid\":%d,\"uid\":%d,\"token\":\"%s\",\"hostTime\":%.9f,\"maxBytes\":%llu,\"maxRecords\":%llu}\n",getpid(),geteuid(),token,hostTime(),maxBytes,maxRecords);
    pthread_mutex_lock(&mutex); bool loaded=line(out,length); pthread_mutex_unlock(&mutex); if(!loaded)return;
    id<MTLDevice> device=MTLCreateSystemDefaultDevice();
    if(!device) { unavailable("metal-device-unavailable"); return; }
    id<MTLCommandQueue> queue=[device newCommandQueue]; id<MTLCommandBuffer> buffer=[queue commandBuffer];
    Class concrete=object_getClass(buffer); Method method=class_getInstanceMethod(concrete,@selector(commit));
    if(!method) { unavailable("public-command-buffer-commit-unavailable"); return; }
    originalCommit=method_getImplementation(method); hookedClass=concrete;
    if(!class_addMethod(concrete,@selector(commit),(IMP)observedCommit,method_getTypeEncoding(method))) method_setImplementation(class_getInstanceMethod(concrete,@selector(commit)),(IMP)observedCommit);
    if(class_getMethodImplementation(concrete,@selector(commit))!=(IMP)observedCommit) { unavailable("commit-hook-readback-failed"); return; }
    pthread_t controller;
    if(pthread_create(&controller,NULL,controlWorker,NULL)) { unavailable("control-worker-unavailable"); return; }
    pthread_detach(controller);
    pthread_mutex_lock(&mutex); while(!controlReady)pthread_cond_wait(&stateChanged,&mutex); bool failed=controlFailed; pthread_mutex_unlock(&mutex);
    if(failed) { unavailable("control-watch-unavailable"); return; }
    length=snprintf(out,sizeof(out),"{\"kind\":\"capability\",\"enabled\":true,\"strategy\":\"public-command-buffer-commit\",\"hostTime\":%.9f}\n",hostTime());
    pthread_mutex_lock(&mutex); line(out,length); pthread_mutex_unlock(&mutex);
  }
}
static void closeLocked(const char *reason) {
  if(journal>=0 && !closed) {
    accepting=false; captureStopped=true; if(!admissionEndTime)admissionEndTime=hostTime();
    if(hookedClass && class_getMethodImplementation(hookedClass,@selector(commit))==(IMP)observedCommit)method_setImplementation(class_getInstanceMethod(hookedClass,@selector(commit)),originalCommit);
    char out[1024]; int size=snprintf(out,sizeof(out),"{\"kind\":\"close\",\"reason\":\"%s\",\"admissionEndHostTime\":%.9f,\"hostTime\":%.9f,\"observedCommits\":%llu,\"admittedCommits\":%llu,\"completions\":%llu,\"active\":%llu,\"rejected\":%llu,\"errors\":%llu,\"observerErrors\":%llu,\"writeFailures\":%llu}\n",reason,admissionEndTime,hostTime(),observed,admitted,completed,active,rejected,errors,observerErrors,writeFailures);
    line(out,size); if(fsync(journal))warning("journal-fsync-failure"); closed=true; close(journal); journal=-1;
  }
}
__attribute__((destructor)) static void closeDiagnostic(void) {
  pthread_mutex_lock(&mutex); closeLocked("process-exit"); pthread_mutex_unlock(&mutex);
}
