package fixture.dynamicv23.configuration;

import fixture.dynamicv23.extensions.V23FiniteSelector;
import fixture.dynamicv23.extensions.V23FiniteRegistrar;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

@Configuration
@Import({V23FiniteSelector.class, V23FiniteRegistrar.class})
public class WithoutMarkerConfiguration {}
