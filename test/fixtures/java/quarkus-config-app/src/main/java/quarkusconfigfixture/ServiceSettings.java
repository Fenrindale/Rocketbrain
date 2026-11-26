package quarkusconfigfixture;

import io.smallrye.config.ConfigMapping;
import io.smallrye.config.WithDefault;
import io.smallrye.config.WithName;
import io.smallrye.config.WithParentName;
import java.time.Duration;
import java.util.Optional;

@ConfigMapping(prefix = "sample")
public interface ServiceSettings {
    Listener listener();

    @WithParentName
    ClientTuning tuning();

    Credentials credentials();

    String customLabel();

    interface Listener {
        @WithName("tcp-port")
        int port();

        @WithDefault("false")
        boolean tls();

        Optional<Duration> timeout();
    }

    interface Credentials {
        String password();
        String privateOther();
    }
}
