package fixture.boot;
import org.springframework.context.annotation.*;
import org.springframework.beans.factory.FactoryBean;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.beans.factory.support.*;
@Configuration
public class DynamicConfiguration {
    @Bean @Conditional(FlagCondition.class)
    RuntimeThing conditionalRuntimeThing() { return new RuntimeThing("condition"); }
    @Bean FactoryBean<FactoryProduct> productFactory() {
        return new FactoryBean<>() {
            @Override public FactoryProduct getObject() { return new FactoryProduct(); }
            @Override public Class<?> getObjectType() { return FactoryProduct.class; }
            @Override public boolean isSingleton() { return true; }
        };
    }
    @Bean static BeanDefinitionRegistryPostProcessor dynamicRegistrar() {
        return new BeanDefinitionRegistryPostProcessor() {
            @Override public void postProcessBeanDefinitionRegistry(BeanDefinitionRegistry registry) {
                registry.registerBeanDefinition("registeredRuntimeThing",BeanDefinitionBuilder.genericBeanDefinition(RuntimeThing.class,()->new RuntimeThing("registered")).getBeanDefinition());
            }
            @Override public void postProcessBeanFactory(ConfigurableListableBeanFactory factory) {}
        };
    }
}
