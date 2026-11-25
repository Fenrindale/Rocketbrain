package rocketbrain.testing;

import java.io.BufferedWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.platform.engine.DiscoverySelector;
import org.junit.platform.engine.FilterResult;
import org.junit.platform.engine.TestExecutionResult;
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
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;
import org.junit.platform.launcher.listeners.SummaryGeneratingListener;
import org.opentest4j.AssertionFailedError;

/** Owned adapter using the public JUnit Platform launcher and JaCoCo runtime API. */
public final class Runner {
    private static BufferedWriter events;
    private static Properties settings;
    private static String nonce;
    private static long sequence;
    private static final AtomicBoolean coverageSaved = new AtomicBoolean();
    private static int nodeCount;
    private Runner() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("One private configuration URI is required.");
        Path config = Path.of(URI.create(args[0]));
        if (Files.size(config) > 1024 * 1024) throw new IllegalArgumentException("Configuration exceeds limit.");
        settings = new Properties();
        try (var input = Files.newInputStream(config)) { settings.load(input); }
        nonce = value("nonce");
        events = Files.newBufferedWriter(Path.of(URI.create(value("events"))), StandardCharsets.UTF_8, StandardOpenOption.APPEND);
        if (!value("coverageFile").isEmpty()) Runtime.getRuntime().addShutdownHook(new Thread(Runner::saveCoverage, "rocketbrain-test-coverage"));
        int exit = 0;
        try {
            String mode = value("mode");
            if (!Set.of("discover", "run").contains(mode)) throw new IllegalArgumentException("Unsupported execution mode.");
            if(value("framework").equals("testng")){exit=TestNgAdapter.execute(mode);}else{
            var builder = LauncherDiscoveryRequestBuilder.request().filters(ClassNameFilter.includeClassNamePatterns(".*"));
            List<DiscoverySelector> selectors = new ArrayList<>();
            for (int index = 0; index < number("selectorCount"); index++) {
                String kind = value("selector." + index + ".kind"), text = value("selector." + index + ".value");
                selectors.add(switch (kind) {
                    case "uniqueId" -> DiscoverySelectors.selectUniqueId(text);
                    case "class" -> DiscoverySelectors.selectClass(text);
                    case "method" -> DiscoverySelectors.selectMethod(text);
                    case "package" -> DiscoverySelectors.selectPackage(text);
                    default -> throw new IllegalArgumentException("Unsupported selector.");
                });
            }
            if (selectors.isEmpty()) {
                java.util.HashSet<Path> roots = new java.util.HashSet<>();
                for (int index = 0; index < number("rootCount"); index++) roots.add(Path.of(URI.create(value("root." + index))));
                selectors.addAll(DiscoverySelectors.selectClasspathRoots(roots));
            }
            builder.selectors(selectors);
            List<String> excluded = new ArrayList<>();
            for (int index = 0; index < number("excludeCount"); index++) excluded.add(value("exclude." + index));
            if (!excluded.isEmpty()) builder.filters((PostDiscoveryFilter) descriptor -> FilterResult.includedIf(excluded.stream().noneMatch(id -> descriptor.getUniqueId().toString().equals(id) || descriptor.getUniqueId().toString().startsWith(id + "/"))));
            for (int index = 0; index < number("parameterCount"); index++) builder.configurationParameter(value("parameter." + index + ".key"), value("parameter." + index + ".value"));
            if(PerTestCoverage.enabled())builder.configurationParameter("junit.jupiter.execution.parallel.enabled","false");
            Launcher launcher = LauncherFactory.create();
            TestPlan plan = launcher.discover(builder.build());
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
                if(result.getTestsFailedCount()>0 || result.getContainersFailedCount()>0) exit=1;
            } else emit(map("type","complete","summary",map("testsFound",plan.countTestIdentifiers(TestIdentifier::isTest))));
            }
        } catch (Throwable error) {
            emit(map("type","error","error",failure(error)));exit=2;
        } finally { saveCoverage(); events.close(); }
        System.exit(exit);
    }
    private static void emitPlan(TestPlan plan, TestIdentifier test) {
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
    static Map<String,Object> failure(Throwable error) {
        StringWriter stack=new StringWriter();error.printStackTrace(new PrintWriter(stack));
        Map<String,Object> result=map("className",error.getClass().getName(),"message",cut(error.getMessage(),16384),"stack",cut(stack.toString(),65536));
        comparison(error,result);
        result.put("frames",java.util.Arrays.stream(error.getStackTrace()).limit(128).map(frame->map("className",frame.getClassName(),"methodName",frame.getMethodName(),"fileName",frame.getFileName(),"line",Math.max(0,frame.getLineNumber()-1))).toList());return result;
    }
    private static void comparison(Throwable error,Map<String,Object> result) {
        if(error instanceof AssertionFailedError assertion&&assertion.isExpectedDefined()&&assertion.isActualDefined()) {
            var expected=assertion.getExpected();var actual=assertion.getActual();
            setComparison(result,"opentest4j",expected.getStringRepresentation(),actual.getStringRepresentation(),
                expected.getType()==null?"null":expected.getType().getTypeName(),actual.getType()==null?"null":actual.getType().getTypeName());
        } else if(error.getClass()==org.junit.ComparisonFailure.class) {
            var failure=(org.junit.ComparisonFailure)error;
            setStringComparison(result,"junit4",failure.getExpected(),failure.getActual());
        } else if(error.getClass()==junit.framework.ComparisonFailure.class) {
            var failure=(junit.framework.ComparisonFailure)error;
            setStringComparison(result,"junit3",failure.getExpected(),failure.getActual());
        } else if(error.getClass()==AssertionError.class) {
            testNgTextComparison(error,result);
        }
    }
    private static void setStringComparison(Map<String,Object> result,String kind,String expected,String actual) {
        setComparison(result,kind,expected==null?"null":expected,actual==null?"null":actual,
            expected==null?"null":"java.lang.String",actual==null?"null":"java.lang.String");
    }
    private static void setComparison(Map<String,Object> result,String kind,String expected,String actual,String expectedType,String actualType) {
        if(expected==null||actual==null||expected.length()>16384||actual.length()>16384)return;
        result.put("comparisonKind",kind);result.put("expected",expected);result.put("actual",actual);
        if(expectedType!=null)result.put("expectedType",cut(expectedType,512));
        if(actualType!=null)result.put("actualType",cut(actualType,512));
    }
    private static void testNgTextComparison(Throwable error,Map<String,Object> result) {
        StackTraceElement[] frames=error.getStackTrace();
        if(frames.length<2||!frames[0].getClassName().equals("org.testng.Assert")||!frames[0].getMethodName().equals("fail")||
            !frames[1].getClassName().equals("org.testng.Assert")||!frames[1].getMethodName().equals("failNotEquals"))return;
        String message=error.getMessage(),prefix="expected [",separator="] but found [";
        if(message==null||message.length()>33000||!message.endsWith("]"))return;
        int left=message.indexOf(prefix),middle=message.indexOf(separator);
        if(left<0||left!=message.lastIndexOf(prefix)||middle<left+prefix.length()||middle!=message.lastIndexOf(separator)||
            (left>0&&message.charAt(left-1)!=' '))return;
        String expected=message.substring(left+prefix.length(),middle);
        String actual=message.substring(middle+separator.length(),message.length()-1);
        if(expected.indexOf('[')>=0||expected.indexOf(']')>=0||actual.indexOf('[')>=0||actual.indexOf(']')>=0)return;
        setComparison(result,"testng-text",expected,actual,null,null);
    }
    static void saveCoverage() {
        if(settings==null||value("coverageFile").isEmpty()||!coverageSaved.compareAndSet(false,true))return;
        try {
            Object agent=Class.forName("org.jacoco.agent.rt.RT").getMethod("getAgent").invoke(null);
            Class<?> api=Class.forName("org.jacoco.agent.rt.IAgent");
            byte[] data=(byte[])api.getMethod("getExecutionData",boolean.class).invoke(agent,false);
            Files.write(Path.of(URI.create(value("coverageFile"))),data,StandardOpenOption.CREATE_NEW);
        } catch(Throwable error) {try{emit(map("type","coverageError","errorClass",error.getClass().getName()));}catch(Throwable ignored){}}
    }
    static String value(String key) { return new String(Base64.getDecoder().decode(settings.getProperty(key,"")), StandardCharsets.UTF_8); }
    static int number(String key) {String value=value(key);return value.isEmpty()?0:Integer.parseInt(value);}
    private static String cut(String value,int max) {return value==null?"":value.substring(0,Math.min(value.length(),max));}
    static Map<String,Object> map(Object... values) {Map<String,Object> result=new LinkedHashMap<>();for(int i=0;i<values.length;i+=2)result.put((String)values[i],values[i+1]);return result;}
    static synchronized void emit(Map<String,Object> event) {
        if(events==null)return;event.put("nonce",nonce);event.put("sequence",++sequence);event.put("at",Instant.now().toString());
        try {events.write(json(event));events.newLine();events.flush();}catch(java.io.IOException error){throw new java.io.UncheckedIOException(error);}
    }
    private static String json(Object value) {
        if(value==null)return "null";if(value instanceof Boolean||value instanceof Number)return value.toString();
        if(value instanceof Map<?,?> map){List<String> items=new ArrayList<>();map.forEach((key,item)->items.add(json(key.toString())+":"+json(item)));return "{"+String.join(",",items)+"}";}
        if(value instanceof Iterable<?> list){List<String> items=new ArrayList<>();for(Object item:list)items.add(json(item));return "["+String.join(",",items)+"]";}
        StringBuilder out=new StringBuilder("\"");for(char c:value.toString().toCharArray()){switch(c){case '"'->out.append("\\\"");case '\\'->out.append("\\\\");case '\n'->out.append("\\n");case '\r'->out.append("\\r");case '\t'->out.append("\\t");default->{if(c<32)out.append(String.format("\\u%04x",(int)c));else out.append(c);}}}return out.append('"').toString();
    }
}
