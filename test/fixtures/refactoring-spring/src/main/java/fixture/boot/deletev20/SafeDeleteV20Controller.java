package fixture.boot.deletev20;

import java.util.Map;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.Resource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class SafeDeleteV20Controller {
    private final String bean;
    @Resource(name = "v20XmlAlias")
    private String resourceBean;
    @Value("#{@v20KeptBean}")
    private String expressionBean;

    public SafeDeleteV20Controller(@Qualifier("v20KeptBean") String bean) { this.bean = bean; }

    @GetMapping("/refactoring/safe-delete-v20")
    public Map<String, Object> state() {
        if (!bean.equals(resourceBean) || !bean.equals(expressionBean)) throw new IllegalStateException("Bean aliases changed");
        return Map.of("value", 42, "bean", bean);
    }

    private int obsoletePrivateHelper() { return 73; }

    @PostConstruct
    private void initializeV20() { }

    @Scheduled(fixedDelay = 60000)
    private void scheduledV20() { }
}
