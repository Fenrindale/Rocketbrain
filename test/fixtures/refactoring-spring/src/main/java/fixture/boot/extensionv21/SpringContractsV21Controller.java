package fixture.boot.extensionv21;

import java.util.Map;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Import;
import org.springframework.web.bind.annotation.GetMapping;

@V21Controller("v21ContractController")
@Import(V21LiteralSelector.class)
public class SpringContractsV21Controller {
    private final V21LiteralBean bean;

    public SpringContractsV21Controller(@Qualifier("v21LiteralAlias") V21LiteralBean bean) {
        this.bean = bean;
    }

    @GetMapping("/refactoring/spring-contracts-v21")
    public Map<String, Object> springContractsV21State() {
        return Map.of("value", 42, "bean", bean.value(), "initialized", bean.initialized(), "beanName", "v21LiteralBean");
    }

    private int obsoleteExtensionV21Helper() { return 73; }
}
