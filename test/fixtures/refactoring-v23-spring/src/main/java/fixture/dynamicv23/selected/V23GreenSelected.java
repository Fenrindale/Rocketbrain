package fixture.dynamicv23.selected;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class V23GreenSelected {
    @Bean("selectedGreen")
    public String selectedGreen() { return "selected-green"; }
}
