package fixture.dynamicv24.selected;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class V24BlueSelected {
    @Bean("selectedBlue")
    public String selectedBlue() { return "selected-blue"; }
}
