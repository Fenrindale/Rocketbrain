package fixture.dynamicv22.selected;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class V22GreenSelected {
    @Bean("selectedGreen")
    public String selectedGreen() { return "selected-green"; }
}
