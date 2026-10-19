#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <unistd.h>
int main(int argc,const char *argv[]) {
  @autoreleasepool {
    int count=argc>1?atoi(argv[1]):1;if(count<1||count>128)return 2;
    id<MTLDevice> device=MTLCreateSystemDefaultDevice();if(!device)return 3;
    id<MTLCommandQueue> queue=[device newCommandQueue];id<MTLBuffer> data=[device newBufferWithLength:4*1024*1024 options:MTLResourceStorageModeShared];
    for(int i=0;i<count;i++) {
      id<MTLCommandBuffer> command=[queue commandBuffer];id<MTLBlitCommandEncoder> encoder=[command blitCommandEncoder];
      [encoder fillBuffer:data range:NSMakeRange(0,data.length) value:i];[encoder endEncoding];[command commit];[command waitUntilCompleted];
      if(command.status!=MTLCommandBufferStatusCompleted)return 4;
    }
    printf("{\"pid\":%d,\"completed\":%d}\n",getpid(),count); fflush(stdout);
    if(argc>2)usleep((useconds_t)atoi(argv[2])*1000);
    if(argc>3) { id<MTLCommandBuffer> command=[queue commandBuffer]; id<MTLBlitCommandEncoder> encoder=[command blitCommandEncoder]; [encoder fillBuffer:data range:NSMakeRange(0,data.length) value:99]; [encoder endEncoding]; [command commit]; [command waitUntilCompleted]; if(command.status!=MTLCommandBufferStatusCompleted)return 5; }
  }
  return 0;
}
