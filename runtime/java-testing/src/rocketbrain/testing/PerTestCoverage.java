package rocketbrain.testing;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/** Serial callback-interval measurements, not thread/async causality inference. */
final class PerTestCoverage {
    private static String active;
    private static int window;
    private static boolean invalid;
    private static boolean overlap;
    private PerTestCoverage() {}
    static boolean enabled() { return Runner.value("perTestCoverage").equals("true"); }
    static synchronized void start(String id) {
        if (!enabled()) return;
        if (active != null) { overlap=true;reject("Overlapping test callbacks prevent per-test attribution."); return; }
        dump(null); active=id;
    }
    static synchronized void finish(String id) {
        if (!enabled()) return;
        if (!id.equals(active)) { overlap=true;reject("Test finish/start boundaries overlap or do not match."); return; }
        dump(id); active=null;
    }
    static synchronized void finishSuite() {
        if (!enabled()) return;
        if (active!=null) reject("A test did not reach its terminal coverage boundary.");
        dump(null);
        Runner.emit(Runner.map("type","perTestCoverage","state",invalid?"unavailable":"available","scope","test-execution-interval","concurrencyObserved",overlap,"limitation","Serial global JaCoCo probe intervals observe background/async activity without proving causality; TestNG method configurations and shared suite/class work are unattributed."));
    }
    private static void reject(String message) {
        if(!invalid)Runner.emit(Runner.map("type","perTestCoverageError","message",message));invalid=true;
    }
    private static void dump(String id) {
        try {
            if(++window>2000){reject("Per-test coverage window limit exceeded.");return;}
            Object agent=Class.forName("org.jacoco.agent.rt.RT").getMethod("getAgent").invoke(null);
            byte[] bytes=(byte[])Class.forName("org.jacoco.agent.rt.IAgent").getMethod("getExecutionData",boolean.class).invoke(agent,true);
            String file=String.format("coverage-window-%06d.exec",window);
            Path directory=Path.of(java.net.URI.create(Runner.value("coverageFile"))).getParent();
            Files.write(directory.resolve(file),bytes,StandardOpenOption.CREATE_NEW);
            Runner.emit(Runner.map("type","coverageWindow","testId",id,"file",file,"scope",id==null?"unattributed-lifecycle-interval":"test-execution-interval"));
        } catch(Throwable failure){reject("A JaCoCo interval could not be measured: "+failure.getClass().getSimpleName());}
    }
}
