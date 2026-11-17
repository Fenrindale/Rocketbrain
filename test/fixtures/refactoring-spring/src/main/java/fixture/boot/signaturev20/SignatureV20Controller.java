package fixture.boot.signaturev20;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class SignatureV20Controller {
    @GetMapping("/refactoring/signature-v20")
    public Map<String, String> signatureState() {
        SignatureContract service = new SignatureChild();
        return Map.of(
            "family", service.combine("family", 3, 0),
            "overload", SignatureOverloads.format("overload", 4, 0),
            "otherOverload", SignatureOverloads.format("keep"),
            "constructor", new SignatureConstructors("ctor", 5, 0).value(),
            "otherConstructor", new SignatureConstructors("keep").value()
        );
    }
}
