package quarkusfixture;

import io.smallrye.config.ConfigMapping;
import io.smallrye.config.WithDefault;

@ConfigMapping(prefix = "greeting")
public interface GreetingConfig {
    String text();

    @WithDefault("2")
    int copies();
}
