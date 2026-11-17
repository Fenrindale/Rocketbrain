package rocketbrain.observer;

import java.lang.instrument.Instrumentation;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Map;

/** Explicit startup agent; no attach, environment inspection, or application query execution. */
public final class Agent {
    private Agent() {}
    public static void premain(String argument, Instrumentation instrumentation) {
        String stage="options";
        try {
            if (argument == null || !argument.startsWith("config=")) throw new IllegalArgumentException("Explicit config required");
            stage="config-path";
            String configured=argument.substring(7);
            Path path=configured.startsWith("file:")?Path.of(java.net.URI.create(configured)):Path.of(configured);
            if (!path.isAbsolute() || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path)>16384) throw new IllegalArgumentException("Invalid config file");
            stage="config-json";
            Map<String,Object> config=Json.object(Files.readString(path));
            stage="runtime-start";
            ObserverRuntime.start(config);
            stage="transformer-registration";
            instrumentation.addTransformer(new HibernateTransformer(instrumentation),false);
        } catch (Throwable failure) {
            // Do not expose token/config contents or abort the user's application.
            System.err.println("ROCKETBRAIN_JPA_OBSERVER_DISABLED "+stage+" "+failure.getClass().getSimpleName());
            ObserverRuntime.stop();
        }
    }
}
