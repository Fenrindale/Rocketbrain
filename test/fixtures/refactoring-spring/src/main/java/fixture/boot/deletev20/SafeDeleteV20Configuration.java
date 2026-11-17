package fixture.boot.deletev20;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.ImportResource;

@Configuration
@ImportResource("classpath:deletev20/beans.xml")
public class SafeDeleteV20Configuration {
    @Bean(name = {"v20KeptBean", "v20KeptAlias"})
    public String keptFactory() { return "kept"; }
}
