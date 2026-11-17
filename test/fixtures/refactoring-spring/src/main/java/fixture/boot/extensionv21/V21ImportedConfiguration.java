package fixture.boot.extensionv21;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

@Configuration(proxyBeanMethods = false)
@Import(V21LiteralRegistrar.class)
public class V21ImportedConfiguration {
    @Bean
    public static V21IdentityProcessor v21IdentityProcessor() {
        return new V21IdentityProcessor();
    }
}
