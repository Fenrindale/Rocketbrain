package fixture.feign;

import fixture.shared.IntermediateContract;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

@FeignClient(name = "catalog", url = "${fixture.upstream-url}", path = "/partner")
public interface CatalogClient extends IntermediateContract {
    @Override @GetMapping("/new-notice")
    String notice();
}
