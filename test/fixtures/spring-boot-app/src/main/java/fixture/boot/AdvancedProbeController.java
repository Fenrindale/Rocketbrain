package fixture.boot;
import java.util.Map;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
@RestController
public class AdvancedProbeController {
    private final AdvancedProbeService service;
    public AdvancedProbeController(AdvancedProbeService service){this.service=service;}
    @GetMapping("/probe/advanced") public Map<String,Object> complex(){
        Map<String,Object> result=service.complexQueries();
        result.putAll(service.invalidQueries());return result;
    }
    @GetMapping("/probe/advanced/mappings") public Map<String,Object> mappings(){return service.mappings();}
    @GetMapping("/probe/advanced/bulk") public Map<String,Object> bulk(){return service.bulkRollback();}
}
