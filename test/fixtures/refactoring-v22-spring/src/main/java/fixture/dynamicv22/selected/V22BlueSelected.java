package fixture.dynamicv22.selected;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class V22BlueSelected {
    @Bean("selectedBlue")
    public String selectedBlue() { return "selected-blue"; }
}
