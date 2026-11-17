package fixture.boot.extensionv21;

import org.springframework.beans.factory.config.BeanPostProcessor;

public final class V21IdentityProcessor implements BeanPostProcessor {
    @Override
    public Object postProcessBeforeInitialization(Object bean, String name) {
        return bean;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String name) {
        return bean;
    }
}
