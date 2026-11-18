package fixture.dynamicv22.extensions;

import fixture.dynamicv22.selected.V22BlueBean;
import fixture.dynamicv22.selected.V22GreenBean;
import org.springframework.context.annotation.ImportBeanDefinitionRegistrar;
import org.springframework.core.type.AnnotationMetadata;
import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.beans.factory.support.RootBeanDefinition;

public final class V22FiniteRegistrar implements ImportBeanDefinitionRegistrar {
    @Override
    public void registerBeanDefinitions(AnnotationMetadata metadata, BeanDefinitionRegistry registry) {
        final String prefix = "finite";
        if (metadata.isAnnotated("org.springframework.context.annotation.Profile")) {
            registry.registerBeanDefinition(prefix + "Blue", new RootBeanDefinition(V22BlueBean.class));
            registry.registerAlias(prefix + "Blue", prefix + "BlueAlias");
        } else {
            registry.registerBeanDefinition(prefix + "Green", new RootBeanDefinition(V22GreenBean.class));
            registry.registerAlias(prefix + "Green", prefix + "GreenAlias");
        }
    }
}
