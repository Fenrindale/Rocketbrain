package fixture.dynamicv24.configuration;

import fixture.dynamicv24.extensions.V24FiniteSelector;
import fixture.dynamicv24.extensions.V24FiniteRegistrar;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import fixture.dynamicv24.annotations.V24Choice;

@Configuration
@V24Choice(route="blue")
@Import({V24FiniteSelector.class, V24FiniteRegistrar.class})
public class BlueConfiguration {}
