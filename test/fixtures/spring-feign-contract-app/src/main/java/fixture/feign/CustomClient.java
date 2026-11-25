package fixture.feign;

import feign.Contract;
import feign.Headers;
import java.util.List;
import feign.MethodMetadata;
import feign.Param;
import feign.RequestLine;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.context.annotation.Bean;

@FeignClient(name = "custom", url = "${fixture.upstream-url}", path = "${fixture.custom-prefix}", configuration = CustomFeignConfig.class)
public interface CustomClient {
    @Headers("X-Private-Contract: private-header-feign-fixture")
    @RequestLine("POST /native/{id}?token=private-query-feign-fixture")
    String custom(@Param("id") int id);
}

class CustomFeignConfig {
    @Bean
    Contract nativeContract() { return new RewritingFeignContract(); }
}

class RewritingFeignContract implements Contract {
    private final Contract delegate = new Contract.Default();

    @Override public List<MethodMetadata> parseAndValidateMetadata(Class<?> targetType) {
        List<MethodMetadata> methods = delegate.parseAndValidateMetadata(targetType);
        for (MethodMetadata method : methods) method.template().uri("/rewritten" + method.template().url());
        return methods;
    }
}
