package fixtures.valid;
import java.nio.file.*;
import java.io.*;
import java.util.*;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.MapPropertySource;
import fixtures.invalid.*;

public class SpringProbe {
    private static String quote(String text) { return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
    public static void main(String[] args) throws Exception {
        String profile = args[0];
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
            context.getEnvironment().setActiveProfiles(profile);
            Properties properties = new Properties();
            for (String name : new String[]{"application.properties", "application-" + profile + ".properties"}) {
                Path file = Path.of(args[1], name);
                if (Files.exists(file)) try (Reader reader = Files.newBufferedReader(file)) { properties.load(reader); }
            }
            Map<String,Object> values = new HashMap<>(); properties.forEach((key, value) -> values.put(key.toString(), value));
            context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("fixture", values));
            if (profile.equals("ambiguous")) context.register(BadConfig.class, AmbiguousConsumer.class);
            else if (profile.equals("missing")) context.register(MissingConsumer.class);
            else context.register(AppConfig.class, BluePort.class, RedPort.class, DevPort.class, Consumer.class, DevConsumer.class, Settings.class);
            try { context.refresh(); }
            catch (Exception failure) {
                Throwable root = failure; while (root.getCause() != null) root = root.getCause();
                System.out.println("ROCKETBRAIN_SPRING_RESULT={\"profile\":" + quote(profile) + ",\"error\":" + quote(root.getClass().getSimpleName()) + "}"); return;
            }
            String[] portNames = context.getBeanNamesForType(Port.class); Arrays.sort(portNames);
            Holder holder = context.getBean(Holder.class);
            String preferred = profile.equals("prod") ? context.getBean(Consumer.class).preferred.id() : "inactive";
            String blue = profile.equals("prod") ? context.getBean(Consumer.class).blue.id() : context.getBean(DevConsumer.class).dependency.id();
            String greeting = profile.equals("prod") ? context.getBean(Consumer.class).greeting : context.getBean(DevConsumer.class).greeting;
            String ports = Arrays.stream(portNames).map(SpringProbe::quote).reduce((left, right) -> left + "," + right).orElse("");
            System.out.println("ROCKETBRAIN_SPRING_RESULT={\"profile\":" + quote(profile) + ",\"ports\":[" + ports + "],\"preferred\":" + quote(preferred) + ",\"blue\":" + quote(blue) + ",\"greeting\":" + quote(greeting) + ",\"settingsPerson\":" + quote(context.getBean(Settings.class).getPerson()) + ",\"holderGreeting\":" + quote(holder.greeting) + ",\"feature\":" + context.containsBean("feature") + ",\"unknownThing\":" + context.containsBean("unknownThing") + "}");
        }
    }
}
