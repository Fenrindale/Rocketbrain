package fixture.dynamicv24.extensions;

import fixture.dynamicv24.selected.V24BlueBean;
import fixture.dynamicv24.selected.V24GreenBean;
import org.springframework.context.annotation.ImportBeanDefinitionRegistrar;
import org.springframework.core.type.AnnotationMetadata;
import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.beans.factory.support.RootBeanDefinition;

public final class V24FiniteRegistrar implements ImportBeanDefinitionRegistrar {
    @Override
    public void registerBeanDefinitions(AnnotationMetadata metadata, BeanDefinitionRegistry registry) {
        final String prefix = "finite";
        switch (metadata.getClassName()) {
            case "fixture.dynamicv24.configuration.BlueConfiguration" -> {
                registry.registerBeanDefinition(prefix + "Blue", new RootBeanDefinition(V24BlueBean.class));
                registry.registerAlias(prefix + "Blue", prefix + "BlueAlias");
            }
            case "fixture.dynamicv24.configuration.GreenConfiguration" -> {
                registry.registerBeanDefinition(prefix + "Green", new RootBeanDefinition(V24GreenBean.class));
                registry.registerAlias(prefix + "Green", prefix + "GreenAlias");
            }
            default -> {}
        }
    }
}
