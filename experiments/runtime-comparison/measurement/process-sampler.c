// A long-lived, read-only process sampler. Protocol: roots|extras|includeWebKit,
// with comma-separated PIDs (or -), one request and one JSON response per line.
#include <sys/types.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <sched.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define RUNTIME 1
#define BACKEND 2
#define WEBKIT 4
#define MAX_ROOTS 1024

typedef pid_t (*responsible_fn)(pid_t);
static mach_timebase_info_data_t timebase;
static responsible_fn responsible;
static bool energy_supported;
static int argmax_size = 262144;
extern int frontmost_pid(void);
extern int running_bundle_pids(const char *path, int *pids, int capacity);

typedef struct {
  struct proc_bsdinfo info;
  int flags;
  bool requested_root, requested_extra, webkit_root;
  pid_t responsible_pid;
} process_entry;

static uint64_t ns(uint64_t value) {
  __uint128_t result = (__uint128_t)value * timebase.numer / timebase.denom;
  return result > UINT64_MAX ? UINT64_MAX : (uint64_t)result;
}

static void json_string(const char *s) {
  if (!s) { fputs("null", stdout); return; }
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    switch (*p) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\b': fputs("\\b", stdout); break;
      case '\f': fputs("\\f", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default: if (*p < 0x20) printf("\\u%04x", *p); else putchar(*p);
    }
  }
  putchar('"');
}

static bool get_bsd(pid_t pid, struct proc_bsdinfo *out) {
  memset(out, 0, sizeof(*out));
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, out, sizeof(*out)) == sizeof(*out);
}

static bool same_birth(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
  return a->pbi_pid == b->pbi_pid && a->pbi_start_tvsec == b->pbi_start_tvsec &&
    a->pbi_start_tvusec == b->pbi_start_tvusec;
}

static bool born_after(const struct proc_bsdinfo *child, const struct proc_bsdinfo *parent) {
  return child->pbi_start_tvsec > parent->pbi_start_tvsec ||
    (child->pbi_start_tvsec == parent->pbi_start_tvsec && child->pbi_start_tvusec >= parent->pbi_start_tvusec);
}

static int parse_pids(char *list, pid_t *out) {
  if (!list) return -1;
  if (strcmp(list, "-") == 0) return 0;
  int count = 0;
  char *save = NULL;
  for (char *token = strtok_r(list, ",", &save); token; token = strtok_r(NULL, ",", &save)) {
    char *end = NULL;
    errno = 0;
    long value = strtol(token, &end, 10);
    if (errno || !*token || *end || value <= 0 || value > INT_MAX || count == MAX_ROOTS) return -1;
    out[count++] = (pid_t)value;
  }
  return count ? count : -1;
}

static bool contains(const pid_t *pids, int count, pid_t pid) {
  for (int i = 0; i < count; i++) if (pids[i] == pid) return true;
  return false;
}

static process_entry *find_process(process_entry *list, int count, pid_t pid) {
  for (int i = 0; i < count; i++) if (list[i].info.pbi_pid == (uint32_t)pid) return &list[i];
  return NULL;
}

static void propagate(process_entry *list, int count) {
  bool changed;
  do {
    changed = false;
    for (int i = 0; i < count; i++) {
      process_entry *p = &list[i];
      process_entry *parent = find_process(list, count, (pid_t)p->info.pbi_ppid);
      if (!parent || parent == p || !parent->flags || !born_after(&p->info, &parent->info)) continue;
      int flags = p->flags | parent->flags;
      if (flags != p->flags) { p->flags = flags; changed = true; }
    }
  } while (changed);
}

static process_entry *read_processes(int *out_count) {
  int capacity = proc_listallpids(NULL, 0);
  if (capacity < 0) return NULL;
  capacity += 256;
  pid_t *pids = NULL;
  int count = 0;
  for (;;) {
    pids = calloc((size_t)capacity, sizeof(*pids));
    if (!pids) return NULL;
    count = proc_listallpids(pids, (int)((size_t)capacity * sizeof(*pids)));
    if (count < 0) { free(pids); return NULL; }
    if (count < capacity) break;
    free(pids);
    if (capacity > INT_MAX / 2 / (int)sizeof(*pids)) { errno = EOVERFLOW; return NULL; }
    capacity *= 2;
  }
  process_entry *list = calloc((size_t)(count ? count : 1), sizeof(*list));
  if (!list) { free(pids); return NULL; }
  int used = 0;
  for (int i = 0; i < count; i++) {
    struct proc_bsdinfo info;
    if (pids[i] > 0 && get_bsd(pids[i], &info)) list[used++].info = info;
  }
  free(pids);
  *out_count = used;
  return list;
}

static void print_argv(pid_t pid) {
  int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t length = (size_t)argmax_size;
  char *buffer = malloc(length);
  if (!buffer || sysctl(mib, 3, buffer, &length, NULL, 0) != 0 || length < sizeof(int)) {
    free(buffer); fputs("null", stdout); return;
  }
  int argc = 0;
  memcpy(&argc, buffer, sizeof(argc));
  char *p = buffer + sizeof(argc), *end = buffer + length;
  while (p < end && *p) p++; // executable path
  while (p < end && !*p) p++; // alignment padding
  if (argc < 0 || argc > 65536 || p == end) { free(buffer); fputs("null", stdout); return; }
  putchar('[');
  bool first = true;
  for (int i = 0; i < argc && p < end; i++) {
    char *terminator = memchr(p, 0, (size_t)(end - p));
    if (!terminator) break;
    if (!first) putchar(',');
    json_string(p);
    first = false;
    p = terminator + 1;
  }
  putchar(']');
  free(buffer);
}

static void print_entry(process_entry *p) {
  pid_t pid = (pid_t)p->info.pbi_pid;
  struct proc_bsdinfo before, after;
  struct rusage_info_v6 usage = {0};
  int error = 0, flavor = RUSAGE_INFO_V6;
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (!get_bsd(pid, &before) || !same_birth(&p->info, &before)) error = ESRCH;
  if (!error && proc_pid_rusage(pid, flavor, (rusage_info_t *)&usage) != 0) {
    error = errno;
    if (error == EINVAL) {
      flavor = RUSAGE_INFO_V0;
      memset(&usage, 0, sizeof(usage));
      if (proc_pid_rusage(pid, flavor, (rusage_info_t *)&usage) == 0) error = 0;
      else error = errno;
    }
  }
  uint64_t observed = ns(mach_absolute_time());
  if (!error) {
    proc_pidpath(pid, path, sizeof(path));
    // Reject a PID reused during the read, rather than mixing two processes.
    if (!get_bsd(pid, &after) || !same_birth(&p->info, &after)) error = ESRCH;
  }
  printf("{\"pid\":%d,\"ppid\":%u,\"uid\":%u,\"birthSeconds\":%" PRIu64 ",\"birthMicroseconds\":%" PRIu64,
    pid, p->info.pbi_ppid, p->info.pbi_uid, p->info.pbi_start_tvsec, p->info.pbi_start_tvusec);
  printf(",\"runtimeMember\":%s,\"extraMember\":%s,\"explicitRoot\":%s,\"explicitExtra\":%s,\"webKitRelated\":%s,\"webKitRoot\":%s,\"responsiblePid\":",
    p->flags & RUNTIME ? "true" : "false", p->flags & BACKEND ? "true" : "false",
    p->requested_root ? "true" : "false", p->requested_extra ? "true" : "false",
    p->flags & WEBKIT ? "true" : "false", p->webkit_root ? "true" : "false");
  pid_t responsible_pid = p->responsible_pid;
  if (responsible && responsible_pid <= 0) responsible_pid = responsible(pid);
  if (responsible_pid > 0) printf("%d", responsible_pid); else fputs("null", stdout);
  fputs(",\"name\":", stdout); json_string(p->info.pbi_name[0] ? p->info.pbi_name : p->info.pbi_comm);
  fputs(",\"executable\":", stdout); json_string(path[0] ? path : NULL);
  fputs(",\"argv\":", stdout);
  if (error) fputs("null", stdout); else print_argv(pid);
  printf(",\"sampleMonotonicNsExact\":\"%" PRIu64 "\",\"error\":", observed);
  if (error) { json_string(strerror(error)); fputs(",\"counters\":null}", stdout); return; }
  fputs("null", stdout);
  printf(",\"counters\":{\"cpuUserNsExact\":\"%" PRIu64 "\",\"cpuSystemNsExact\":\"%" PRIu64 "\",\"residentBytes\":%" PRIu64 ",\"physicalFootprintBytes\":%" PRIu64 ",\"startMonotonicNsExact\":\"%" PRIu64 "\",\"cpuEnergyNjExact\":",
    ns(usage.ri_user_time), ns(usage.ri_system_time), usage.ri_resident_size, usage.ri_phys_footprint, ns(usage.ri_proc_start_abstime));
  if (energy_supported && flavor == RUSAGE_INFO_V6) printf("\"%" PRIu64 "\"", usage.ri_energy_nj);
  else fputs("null", stdout);
  fputs("}}", stdout);
}

static void snapshot(char *line) {
  char *first = strchr(line, '|'), *second = first ? strchr(first + 1, '|') : NULL;
  if (!first || !second) { puts("{\"error\":\"Invalid sampler request\"}"); return; }
  *first++ = 0; *second++ = 0;
  pid_t roots[MAX_ROOTS], extras[MAX_ROOTS];
  int root_count = parse_pids(line, roots), extra_count = parse_pids(first, extras);
  if (root_count < 0 || extra_count < 0 || (strcmp(second, "0") && strcmp(second, "1"))) {
    puts("{\"error\":\"Invalid sampler request\"}"); return;
  }
  uint64_t start = ns(mach_absolute_time());
  int count = 0;
  process_entry *list = read_processes(&count);
  if (!list) { fputs("{\"error\":", stdout); json_string(strerror(errno)); puts("}"); return; }
  for (int i = 0; i < count; i++) {
    process_entry *p = &list[i];
    p->requested_root = contains(roots, root_count, (pid_t)p->info.pbi_pid);
    p->requested_extra = contains(extras, extra_count, (pid_t)p->info.pbi_pid);
    if (p->requested_root) p->flags |= RUNTIME;
    if (p->requested_extra) p->flags |= BACKEND;
  }
  propagate(list, count);
  if (*second == '1' && responsible) {
    for (int i = 0; i < count; i++) {
      process_entry *p = &list[i];
      const char *name = p->info.pbi_name[0] ? p->info.pbi_name : p->info.pbi_comm;
      if (strncmp(name, "com.apple.WebKit.", 17)) continue;
      char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
      if (proc_pidpath((pid_t)p->info.pbi_pid, path, sizeof(path)) <= 0 ||
          !strstr(path, "/WebKit.framework/") || !strstr(path, "/XPCServices/")) continue;
      p->responsible_pid = responsible((pid_t)p->info.pbi_pid);
      process_entry *owner = find_process(list, count, p->responsible_pid);
      if (!owner || owner == p || !(owner->flags & (RUNTIME | BACKEND)) ||
          owner->info.pbi_uid != p->info.pbi_uid || !born_after(&p->info, &owner->info)) continue;
      p->flags |= (owner->flags & (RUNTIME | BACKEND)) | WEBKIT;
      p->webkit_root = true;
    }
    propagate(list, count);
  }
  printf("{\"sampleStartMonotonicNsExact\":\"%" PRIu64 "\",\"timebase\":{\"numer\":%u,\"denom\":%u},\"responsibleLookupAvailable\":%s,\"cpuEnergySupported\":%s,\"processes\":[",
    start, timebase.numer, timebase.denom, responsible ? "true" : "false", energy_supported ? "true" : "false");
  bool first_entry = true;
  for (int i = 0; i < count; i++) {
    if (!(list[i].flags & (RUNTIME | BACKEND))) continue;
    if (!first_entry) putchar(',');
    print_entry(&list[i]);
    first_entry = false;
  }
  int frontmost = frontmost_pid();
  printf("],\"frontmostPid\":");
  if (frontmost > 0) printf("%d", frontmost); else fputs("null", stdout);
  printf(",\"sampleEndMonotonicNsExact\":\"%" PRIu64 "\"}\n", ns(mach_absolute_time()));
  free(list);
}

int main(void) {
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom) {
    fputs("Cannot read Mach timebase.\n", stderr); return 1;
  }
  responsible = (responsible_fn)dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
  int mib[] = { CTL_KERN, KERN_ARGMAX };
  size_t size = sizeof(argmax_size);
  if (sysctl(mib, 2, &argmax_size, &size, NULL, 0) != 0 || argmax_size <= 0 || argmax_size > 4 * 1024 * 1024) argmax_size = 262144;
  // A zero energy field can also mean the kernel does not support the counter.
  // Spend ~5 ms once, then require this helper's counter to advance before reporting it.
  struct rusage_info_v6 before = {0}, after = {0};
  if (proc_pid_rusage(getpid(), RUSAGE_INFO_V6, (rusage_info_t *)&before) == 0) {
    uint64_t until = ns(mach_absolute_time()) + 5000000;
    while (ns(mach_absolute_time()) < until) { }
    sched_yield();
    usleep(1000);
    if (proc_pid_rusage(getpid(), RUSAGE_INFO_V6, (rusage_info_t *)&after) == 0 && after.ri_energy_nj > before.ri_energy_nj) energy_supported = true;
  }
  setvbuf(stdout, NULL, _IOLBF, 0);
  char *line = NULL;
  size_t capacity = 0;
  while (getline(&line, &capacity, stdin) > 0) {
    line[strcspn(line, "\r\n")] = 0;
    if (!strncmp(line, "bundle|", 7)) {
      int pids[MAX_ROOTS], count = running_bundle_pids(line + 7, pids, MAX_ROOTS);
      if (count < 0) puts("{\"error\":\"Too many processes for the owned bundle\"}");
      else {
        fputs("{\"pids\":[", stdout);
        for (int i = 0; i < count; i++) printf("%s%d", i ? "," : "", pids[i]);
        puts("]}");
      }
    } else snapshot(line);
  }
  free(line);
  return 0;
}
