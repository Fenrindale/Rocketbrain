package fixture;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class WslSpringConfiguration {
    @Bean
    String toolchainMarker() {
        return "wsl-spring";
    }
}
