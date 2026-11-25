package fixture.boot;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.persistence.autoconfigure.EntityScan;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "fixture.fetch-multi.enabled", havingValue = "true")
@EntityScan(basePackages = {"fixture.boot", "fixture.multifetch"})
class MultiFetchFixtureConfig {}
