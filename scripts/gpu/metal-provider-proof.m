#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <unistd.h>
#include <time.h>
#include <sys/resource.h>
static double seconds(struct timeval value) { return value.tv_sec + value.tv_usec / 1e6; }
int main(int argc,const char *argv[]) {
  @autoreleasepool {
    int count=argc>1?atoi(argv[1]):1;if(count<1||count>128)return 2;
    id<MTLDevice> device=MTLCreateSystemDefaultDevice();if(!device)return 3;
    id<MTLCommandQueue> queue=[device newCommandQueue];id<MTLBuffer> data=[device newBufferWithLength:4*1024*1024 options:MTLResourceStorageModeShared];
    struct timespec start,end; struct rusage cpuStart,cpuEnd;
    clock_gettime(CLOCK_MONOTONIC_RAW,&start); getrusage(RUSAGE_SELF,&cpuStart);
    for(int i=0;i<count;i++) {
      id<MTLCommandBuffer> command=[queue commandBuffer];id<MTLBlitCommandEncoder> encoder=[command blitCommandEncoder];
      [encoder fillBuffer:data range:NSMakeRange(0,data.length) value:i];[encoder endEncoding];[command commit];[command waitUntilCompleted];
      if(command.status!=MTLCommandBufferStatusCompleted)return 4;
    }
    getrusage(RUSAGE_SELF,&cpuEnd); clock_gettime(CLOCK_MONOTONIC_RAW,&end);
    double wallMS=(end.tv_sec-start.tv_sec)*1000.0+(end.tv_nsec-start.tv_nsec)/1e6;
    double cpuMS=(seconds(cpuEnd.ru_utime)+seconds(cpuEnd.ru_stime)-seconds(cpuStart.ru_utime)-seconds(cpuStart.ru_stime))*1000;
    printf("{\"pid\":%d,\"completed\":%d,\"wallMS\":%.6f,\"cpuMS\":%.6f,\"lastByte\":%u}\n",getpid(),count,wallMS,cpuMS,((unsigned char *)data.contents)[data.length-1]); fflush(stdout);
    if(argc>2)usleep((useconds_t)atoi(argv[2])*1000);
    if(argc>3) { id<MTLCommandBuffer> command=[queue commandBuffer]; id<MTLBlitCommandEncoder> encoder=[command blitCommandEncoder]; [encoder fillBuffer:data range:NSMakeRange(0,data.length) value:99]; [encoder endEncoding]; [command commit]; [command waitUntilCompleted]; if(command.status!=MTLCommandBufferStatusCompleted)return 5; }
  }
  return 0;
}
