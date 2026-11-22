#import <AppKit/AppKit.h>

// NSWorkspace is read-only here; no NSApplication, window, or activation.
int frontmost_pid(void) {
  @autoreleasepool {
    NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
    return app ? app.processIdentifier : 0;
  }
}

// LaunchServices registers an app before its own readiness callback. Match a
// trial-owned bundle path, never a shared name or bundle identifier.
int running_bundle_pids(const char *path, int *pids, int capacity) {
  @autoreleasepool {
    NSURL *bundle = [[NSURL fileURLWithPath:[NSString stringWithUTF8String:path]] URLByResolvingSymlinksInPath];
    int count = 0;
    for (NSRunningApplication *app in [NSWorkspace sharedWorkspace].runningApplications) {
      if ([[app.bundleURL URLByResolvingSymlinksInPath].path isEqualToString:bundle.path]) {
        if (count == capacity) return -1;
        pids[count++] = app.processIdentifier;
      }
    }
    return count;
  }
}
