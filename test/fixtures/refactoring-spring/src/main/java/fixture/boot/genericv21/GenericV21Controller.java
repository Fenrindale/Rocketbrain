package fixture.boot.genericv21;

import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class GenericV21Controller {
    @GetMapping("/refactoring/generic-v21")
    public Map<String, Object> values() {
        GenericContract<String> contract = new GenericChild();
        GenericBase<String> base = new GenericChild();
        GenericChild child = new GenericChild();
        String value = "generic:stable";
        Integer number = 8;
        List<Integer> numbers = List.of(1, 2, 3);
        return Map.of("family", contract.convert(value, 0), "base", base.convert(value, 0),
            "child", child.convert(value, 0), "methodValue", GenericMethods.bounded(number, 0),
            "otherOverload", GenericMethods.bounded("keep"), "listValue", GenericMethods.wildcard(numbers, 0));
    }
}
