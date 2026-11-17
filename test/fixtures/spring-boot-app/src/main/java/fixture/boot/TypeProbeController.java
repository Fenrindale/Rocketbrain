package fixture.boot;
import java.util.*;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
@RestController
public class TypeProbeController {
    private final TypeProbeService service;
    public TypeProbeController(TypeProbeService service){this.service=service;}
    @GetMapping("/probe/types") public Map<String,Object> types(){return service.validTypes();}
    @GetMapping("/probe/types/invalid") public Map<String,Object> invalid(){return service.invalidTypes();}
    @GetMapping("/probe/types/dynamic") public Map<String,Object> dynamic(){return Map.of("city",service.dynamicQueries(true),"department",service.dynamicQueries(false));}
    @GetMapping("/probe/types/spel") public Map<String,Object> spel(){return service.spelQueries();}
    @GetMapping("/probe/types/spel-errors") public Map<String,Object> spelErrors(){return service.spelErrors();}
}
