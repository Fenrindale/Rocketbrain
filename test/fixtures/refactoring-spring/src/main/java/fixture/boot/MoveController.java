package fixture.boot;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MoveController {
    @GetMapping("/refactoring/move")
    public int value() { return MoveCalculator.value(); }
}
