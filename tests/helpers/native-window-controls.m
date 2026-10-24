#import <AppKit/AppKit.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

// No Node calls are needed: dlopen runs this initializer synchronously each time.
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;

static NSDictionary *WindowRect(NSView *view, NSWindow *window) {
  NSRect screen = [window convertRectToScreen:[view convertRect:view.bounds toView:nil]];
  NSRect frame = window.frame;
  return @{ @"x": @(NSMinX(screen) - NSMinX(frame)),
            @"y": @(NSMaxY(frame) - NSMaxY(screen)),
            @"width": @(NSWidth(screen)), @"height": @(NSHeight(screen)) };
}

static id ButtonRect(NSWindow *window, NSWindowButton kind) {
  NSButton *button = [window standardWindowButton:kind];
  if (!button) return NSNull.null;
  NSMutableDictionary *rect = [WindowRect(button, window) mutableCopy];
  rect[@"hidden"] = @(button.hidden);
  rect[@"hiddenOrHasHiddenAncestor"] = @(button.hiddenOrHasHiddenAncestor);
  return rect;
}

static NSDictionary *Measure(void) {
  if (!NSThread.isMainThread) return @{ @"error": @"AppKit geometry must be read on the main thread." };
  const char *handle = getenv("PERPETUAL_SWAP_NATIVE_WINDOW_CONTROLS_HANDLE");
  char *end = NULL;
  errno = 0;
  unsigned long long address = handle ? strtoull(handle, &end, 16) : 0;
  if (!address || errno || !end || *end || address > UINTPTR_MAX)
    return @{ @"error": @"A valid target NSView handle is required." };
  NSView *view = (__bridge NSView *)(void *)(uintptr_t)address;
  NSWindow *window = view.window;
  if (!window) return @{ @"error": @"The target NSView has no NSWindow." };
  return @{ @"frame": @{ @"width": @(NSWidth(window.frame)), @"height": @(NSHeight(window.frame)) },
            @"content": WindowRect(window.contentView, window),
            @"backingScaleFactor": @(window.backingScaleFactor),
            @"buttons": @{ @"close": ButtonRect(window, NSWindowCloseButton),
                           @"minimize": ButtonRect(window, NSWindowMiniaturizeButton),
                           @"zoom": ButtonRect(window, NSWindowZoomButton) } };
}

__attribute__((visibility("default")))
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  (void)env;
  @autoreleasepool {
    const char *path = getenv("PERPETUAL_SWAP_NATIVE_WINDOW_CONTROLS_REPORT");
    if (!path) return exports;
    NSDictionary *report;
    @try { report = Measure(); }
    @catch (NSException *exception) { report = @{ @"error": exception.reason ?: exception.name }; }
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:report options:0 error:&error];
    if (!json || ![json writeToFile:[NSString stringWithUTF8String:path] options:NSDataWritingAtomic error:&error])
      fprintf(stderr, "Native window controls report failed: %s\n", error.localizedDescription.UTF8String);
  }
  return exports;
}
