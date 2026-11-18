package fixture.dynamicv22.app;

import fixture.dynamicv22.configuration.WithProfileConfiguration;
import fixture.dynamicv22.configuration.WithoutProfileConfiguration;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Import;

@SpringBootApplication
@Import({WithProfileConfiguration.class, WithoutProfileConfiguration.class})
public class DynamicContractsApplication {
    public static void main(String[] args) { SpringApplication.run(DynamicContractsApplication.class, args); }
}
