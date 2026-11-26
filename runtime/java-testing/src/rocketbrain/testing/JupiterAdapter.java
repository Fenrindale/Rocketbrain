package rocketbrain.testing;

import static rocketbrain.testing.Runner.*;

import java.net.URI;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import org.junit.platform.engine.DiscoverySelector;
import org.junit.platform.engine.FilterResult;
import org.junit.platform.engine.TestEngine;
import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.engine.UniqueId;
import org.junit.platform.engine.discovery.ClassNameFilter;
import org.junit.platform.engine.discovery.DiscoverySelectors;
import org.junit.platform.engine.support.descriptor.ClassSource;
import org.junit.platform.engine.support.descriptor.FileSource;
import org.junit.platform.engine.support.descriptor.MethodSource;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.PostDiscoveryFilter;
import org.junit.platform.launcher.TestExecutionListener;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;
import org.junit.platform.launcher.core.LauncherConfig;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;
import org.junit.platform.launcher.listeners.SummaryGeneratingListener;
import org.opentest4j.AssertionFailedError;

/** JUnit Platform launcher kept separate from the TestNG boot graph. */
final class JupiterAdapter {
    private static final String ENGINE_MODULE = "org.junit.jupiter.engine";
    private static final String ENGINE_ID = "junit-jupiter";
    private final NamedModuleTests named;
    private int nodeCount;

    JupiterAdapter(NamedModuleTests named) { this.named = named; }

    int execute(String mode) throws Exception {
        var builder = LauncherDiscoveryRequestBuilder.request().filters(ClassNameFilter.includeClassNamePatterns(".*"));
        List<DiscoverySelector> selectors = new ArrayList<>();
        for (int index = 0; index < number("selectorCount"); index++) {
            String kind = value("selector." + index + ".kind"), text = value("selector." + index + ".value");
            selectors.add(named==null?switch (kind) {
                case "uniqueId" -> DiscoverySelectors.selectUniqueId(text);
                case "class" -> DiscoverySelectors.selectClass(text);
                case "method" -> DiscoverySelectors.selectMethod(text);
                case "package" -> DiscoverySelectors.selectPackage(text);
                default -> throw new IllegalArgumentException("Unsupported selector.");
            }:selector(kind,text));
        }
        if (selectors.isEmpty() && named!=null) selectors.add(all());
        if (selectors.isEmpty()) {
            java.util.HashSet<Path> roots = new java.util.HashSet<>();
            for (int index = 0; index < number("rootCount"); index++) roots.add(Path.of(URI.create(value("root." + index))));
            selectors.addAll(DiscoverySelectors.selectClasspathRoots(roots));
        }
        builder.selectors(selectors);
        List<String> excluded = new ArrayList<>();
        for (int index = 0; index < number("excludeCount"); index++) {
            String id=value("exclude." + index);
            if(named!=null)verifyId(id);
            excluded.add(id);
        }
        if (!excluded.isEmpty()) builder.filters((PostDiscoveryFilter) descriptor -> FilterResult.includedIf(excluded.stream().noneMatch(id -> descriptor.getUniqueId().toString().equals(id) || descriptor.getUniqueId().toString().startsWith(id + "/"))));
        for (int index = 0; index < number("parameterCount"); index++) builder.configurationParameter(value("parameter." + index + ".key"), value("parameter." + index + ".value"));
        if(PerTestCoverage.enabled())builder.configurationParameter("junit.jupiter.execution.parallel.enabled","false");
        Launcher launcher = named==null?LauncherFactory.create():launcher();
        TestPlan plan = launcher.discover(builder.build());
        if(named!=null)verifyPlan(plan);
        for (TestIdentifier root : plan.getRoots()) emitPlan(plan, root);
        emit(map("type", "plan", "testsFound", plan.countTestIdentifiers(TestIdentifier::isTest)));
        if (mode.equals("run")) {
            SummaryGeneratingListener summary = new SummaryGeneratingListener();
            launcher.execute(plan, summary, new TestExecutionListener() {
                @Override public void dynamicTestRegistered(TestIdentifier test) { if (++nodeCount > 10000) throw new IllegalStateException("Test node limit exceeded."); emit(withTest("dynamic", test)); }
                @Override public void executionStarted(TestIdentifier test) { if(test.isTest())PerTestCoverage.start(test.getUniqueId());emit(withTest("started", test)); }
                @Override public void executionSkipped(TestIdentifier test, String reason) { Map<String,Object> event=withTest("skipped", test);event.put("reason", cut(reason, 4096));emit(event); }
                @Override public void executionFinished(TestIdentifier test, TestExecutionResult result) {
                    Map<String,Object> event=withTest("finished", test);event.put("state", switch(result.getStatus()) { case SUCCESSFUL -> "passed"; case FAILED -> "failed"; case ABORTED -> "aborted"; });
                    result.getThrowable().ifPresent(error -> event.put("error", failure(error)));emit(event);if(test.isTest())PerTestCoverage.finish(test.getUniqueId());
                }
            });
            var result = summary.getSummary();
            Map<String,Object> totals=map("testsFound",result.getTestsFoundCount(),"testsStarted",result.getTestsStartedCount(),"testsSucceeded",result.getTestsSucceededCount(),"testsFailed",result.getTestsFailedCount(),"testsSkipped",result.getTestsSkippedCount(),"testsAborted",result.getTestsAbortedCount(),"containersFailed",result.getContainersFailedCount(),"durationMs",Math.max(0,result.getTimeFinished()-result.getTimeStarted()));
            PerTestCoverage.finishSuite();saveCoverage();
            emit(map("type","complete","summary",totals));
            if(result.getTestsFailedCount()>0 || result.getContainersFailedCount()>0) return 1;
        } else emit(map("type","complete","summary",map("testsFound",plan.countTestIdentifiers(TestIdentifier::isTest))));
        return 0;
    }
    private void emitPlan(TestPlan plan, TestIdentifier test) {
        if (++nodeCount > 10000) throw new IllegalStateException("Test discovery node limit exceeded.");
        emit(withTest("discovered",test));
        plan.getChildren(test).stream().sorted(Comparator.comparing(TestIdentifier::getUniqueId)).forEach(child -> emitPlan(plan,child));
    }
    private static Map<String,Object> withTest(String type, TestIdentifier test) { return map("type",type,"test",describe(test)); }
    private static Map<String,Object> describe(TestIdentifier test) {
        Map<String,Object> result=map("id",test.getUniqueId(),"parentId",test.getParentId().orElse(null),"label",cut(test.getDisplayName(),4096),"kind",test.isTest()?"test":"container","tags",test.getTags().stream().map(tag->tag.getName()).toList());
        test.getSource().ifPresent(source -> {
            if(source instanceof MethodSource method) {result.put("className",method.getClassName());result.put("methodName",method.getMethodName());result.put("methodParameterTypes",method.getMethodParameterTypes());}
            else if(source instanceof ClassSource type) {result.put("className",type.getClassName());type.getPosition().ifPresent(position->result.put("line",position.getLine()-1));}
            else if(source instanceof FileSource file) {result.put("uri",file.getUri().toString());file.getPosition().ifPresent(position->result.put("line",position.getLine()-1));}
        });return result;
    }
    Launcher launcher() {
        var engines = ServiceLoader.load(ModuleLayer.boot(), TestEngine.class).stream()
            .filter(provider -> ENGINE_MODULE.equals(provider.type().getModule().getName()))
            .toList();
        if (engines.size() != 1) throw new IllegalArgumentException("The pinned named Jupiter engine was not uniquely resolved.");
        TestEngine engine = engines.getFirst().get();
        if (!ENGINE_ID.equals(engine.getId())) throw new IllegalArgumentException("The resolved named test engine differs from Jupiter.");
        return LauncherFactory.create(LauncherConfig.builder()
            .enableTestEngineAutoRegistration(false).enableLauncherDiscoveryListenerAutoRegistration(false)
            .enableLauncherSessionListenerAutoRegistration(false).enablePostDiscoveryFilterAutoRegistration(false)
            .enableTestExecutionListenerAutoRegistration(false).addTestEngines(engine).build());
    }

    DiscoverySelector all() {
        return DiscoverySelectors.selectModule(named.name());
    }

    DiscoverySelector selector(String kind, String text) {
        return switch (kind) {
            case "class" -> DiscoverySelectors.selectClass(named.requireClass(text));
            case "method" -> {
                int separator = text.indexOf('#');
                if (separator < 1) throw new IllegalArgumentException("Select a method declared inside the named test module.");
                named.requireClass(text.substring(0, separator));
                yield DiscoverySelectors.selectMethod(text);
            }
            case "package" -> {
                if (!named.containsPackage(text)) throw new IllegalArgumentException("The selected package is outside the named test module.");
                yield DiscoverySelectors.selectPackage(text);
            }
            case "uniqueId" -> {
                UniqueId identifier = verifyId(text);
                yield identifier.getSegments().size() == 1 ? all() : DiscoverySelectors.selectUniqueId(identifier);
            }
            default -> throw new IllegalArgumentException("Unsupported named test selector.");
        };
    }

    UniqueId verifyId(String text) {
        var identifier = UniqueId.parse(text);
        if (!identifier.getEngineId().filter(ENGINE_ID::equals).isPresent()) {
            throw new IllegalArgumentException("The selected test does not belong to the pinned named Jupiter engine.");
        }
        if (identifier.getSegments().size() > 1) {
            var first = identifier.getSegments().get(1);
            if (!"class".equals(first.getType())) throw new IllegalArgumentException("Select a class in the reviewed named test module.");
            named.requireClass(first.getValue());
        }
        return identifier;
    }

    void verifyPlan(TestPlan plan) {
        for (TestIdentifier root : plan.getRoots()) {
            verifyId(root.getUniqueId());
            for (TestIdentifier item : plan.getDescendants(root)) {
                var source = item.getSource().orElse(null);
                if (source instanceof ClassSource type) named.requireClass(type.getClassName());
                else if (source instanceof MethodSource method) named.requireClass(method.getClassName());
                else if (item.isTest()) throw new IllegalArgumentException("A discovered test has no class in the selected named module.");
            }
        }
    }

    static void comparison(Throwable error,Map<String,Object> result) {
        if(error instanceof AssertionFailedError assertion&&assertion.isExpectedDefined()&&assertion.isActualDefined()) {
            var expected=assertion.getExpected();var actual=assertion.getActual();
            setComparison(result,"opentest4j",expected.getStringRepresentation(),actual.getStringRepresentation(),
                expected.getType()==null?"null":expected.getType().getTypeName(),actual.getType()==null?"null":actual.getType().getTypeName());
        } else if(error.getClass().getName().equals("org.junit.ComparisonFailure") && error.getClass()==org.junit.ComparisonFailure.class) {
            var failure=(org.junit.ComparisonFailure)error;
            setStringComparison(result,"junit4",failure.getExpected(),failure.getActual());
        } else if(error.getClass().getName().equals("junit.framework.ComparisonFailure") && error.getClass()==junit.framework.ComparisonFailure.class) {
            var failure=(junit.framework.ComparisonFailure)error;
            setStringComparison(result,"junit3",failure.getExpected(),failure.getActual());
        }
    }
}
