package fixture.dynamicv23.selected;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class V23BlueSelected {
    @Bean("selectedBlue")
    public String selectedBlue() { return "selected-blue"; }
}
