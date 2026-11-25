package fixture.shared;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;

public interface CatalogContract {
    @GetMapping("/people/{id}")
    String person(@PathVariable("id") int id);

    @GetMapping("/status")
    String status();

    @GetMapping("/old-notice")
    String notice();
}
