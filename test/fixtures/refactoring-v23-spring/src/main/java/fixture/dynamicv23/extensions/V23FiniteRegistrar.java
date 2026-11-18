package fixture.dynamicv23.extensions;

import fixture.dynamicv23.selected.V23BlueBean;
import fixture.dynamicv23.selected.V23GreenBean;
import org.springframework.context.annotation.ImportBeanDefinitionRegistrar;
import org.springframework.core.type.AnnotationMetadata;
import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.beans.factory.support.RootBeanDefinition;

public final class V23FiniteRegistrar implements ImportBeanDefinitionRegistrar {
    @Override
    public void registerBeanDefinitions(AnnotationMetadata metadata, BeanDefinitionRegistry registry) {
        final String prefix = "finite";
        final String annotations = "fixture.dynamicv23.annotations.";
        final boolean annotated = metadata.isAnnotated(annotations + "V23Enabled");
        final boolean direct = metadata.hasAnnotation(annotations + "V23Composed");
        final boolean enabled = direct && !(!metadata.hasMetaAnnotation(annotations + "V23Enabled"));
        if (enabled != false && annotated) {
            registry.registerBeanDefinition(prefix + "Blue", new RootBeanDefinition(V23BlueBean.class));
            registry.registerAlias(prefix + "Blue", prefix + "BlueAlias");
        } else {
            registry.registerBeanDefinition(prefix + "Green", new RootBeanDefinition(V23GreenBean.class));
            registry.registerAlias(prefix + "Green", prefix + "GreenAlias");
        }
    }
}
