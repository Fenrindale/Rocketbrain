package fixture.dynamicv22.configuration;

import fixture.dynamicv22.extensions.V22FiniteSelector;
import fixture.dynamicv22.extensions.V22FiniteRegistrar;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Profile;

@Configuration
@Profile("!disabled-v22")
@Import({V22FiniteSelector.class, V22FiniteRegistrar.class})
public class WithProfileConfiguration {}
