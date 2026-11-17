package fixture.boot.extensionv21;

import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.beans.factory.support.RootBeanDefinition;
import org.springframework.context.annotation.ImportBeanDefinitionRegistrar;
import org.springframework.core.type.AnnotationMetadata;

public final class V21LiteralRegistrar implements ImportBeanDefinitionRegistrar {
    @Override
    public void registerBeanDefinitions(AnnotationMetadata metadata, BeanDefinitionRegistry registry) {
        registry.registerBeanDefinition("v21LiteralBean", new RootBeanDefinition(V21LiteralBean.class));
        registry.registerAlias("v21LiteralBean", "v21LiteralAlias");
    }
}
