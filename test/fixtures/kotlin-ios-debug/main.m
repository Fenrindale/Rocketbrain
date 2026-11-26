#import <UIKit/UIKit.h>
#import <RocketbrainProbe/RocketbrainProbe.h>

@interface FixtureDelegate : UIResponder <UIApplicationDelegate>
@property (strong, nonatomic) UIWindow *window;
@end

@implementation FixtureDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    self.window.rootViewController = [UIViewController new];
    [self.window makeKeyAndVisible];
    [self performSelector:@selector(measure) withObject:nil afterDelay:0.2];
    return YES;
}

- (void)measure {
    int32_t measured = [[RocketbrainProbeProbe new] measureSeed:40];
    NSURL *library = [[NSFileManager defaultManager] URLsForDirectory:NSLibraryDirectory
                                                           inDomains:NSUserDomainMask].firstObject;
    NSURL *receipt = [library URLByAppendingPathComponent:@"rocketbrain-ios-fixture.txt"];
    NSString *result = [NSString stringWithFormat:@"UIKit Kotlin=%d\n", measured];
    [result writeToURL:receipt atomically:YES encoding:NSUTF8StringEncoding error:nil];
}
@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass(FixtureDelegate.class));
    }
}
