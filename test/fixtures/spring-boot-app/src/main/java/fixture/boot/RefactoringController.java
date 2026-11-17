package fixture.boot;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RefactoringController {
    @GetMapping("/probe/refactoring")
    public Map<String, String> refactoring() {
        return Map.of("value", RefactoringCalculator.formatPair("value:", 3, 7),
            "constructor", new RefactoringCalculator("ctor:", 4, 8).result());
    }
}
