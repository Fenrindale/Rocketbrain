package fixture;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class WslSpringConfiguration {
    @Bean
    String toolchainMarker() {
        return "wsl-spring";
    }

    public static void main(String[] args) throws IOException {
        try (var context = new AnnotationConfigApplicationContext(WslSpringConfiguration.class)) {
            String marker = context.getBean(String.class);
            int answer = 42;
            String result = marker + ':' + answer + ':' + System.getProperty("os.name"); // DEBUG_GATE
            Files.writeString(Path.of("wsl-debug-result.txt"), result);
        }
    }
}
