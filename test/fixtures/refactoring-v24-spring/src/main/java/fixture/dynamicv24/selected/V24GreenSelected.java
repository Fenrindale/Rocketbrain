package fixture.dynamicv24.selected;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class V24GreenSelected {
    @Bean("selectedGreen")
    public String selectedGreen() { return "selected-green"; }
}
