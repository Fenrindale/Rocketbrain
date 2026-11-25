package fixture.boot;
import java.util.*;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.aop.support.AopUtils;
import org.springframework.context.ApplicationContext;
import org.springframework.core.SpringVersion;
import org.springframework.boot.SpringBootVersion;
import jakarta.persistence.EntityManagerFactory;
@RestController
public class ProbeController {
    private final ProbeService service;
    private final EntityManagerFactory emf;
    private final ApplicationContext context;
    public ProbeController(ProbeService service,EntityManagerFactory emf,ApplicationContext context) { this.service=service;this.emf=emf;this.context=context; }
    @GetMapping("/probe/ready") public Map<String,Object> ready() { return Map.of("ready",SeedConfiguration.ready); }
    @GetMapping("/probe/testing-state") public Map<String,Object> testingState() {
        var em=emf.createEntityManager();
        try{return Map.of("people",em.createQuery("select count(p) from Person p",Long.class).getSingleResult(),"departments",em.createQuery("select count(d) from Department d",Long.class).getSingleResult(),"rolledBackNames",em.createQuery("select count(d) from Department d where d.name = 'Rolled-back test department'",Long.class).getSingleResult());}
        finally{em.close();}
    }
    @PostMapping(path="/probe/upload-digest", consumes="application/octet-stream")
    public Map<String,Object> uploadDigest(@RequestBody byte[] bytes) throws NoSuchAlgorithmException {
        return Map.of("length", bytes.length, "sha256", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                "people", testingState().get("people"));
    }
    @PostMapping("/probe/session/start")
    public ResponseEntity<Map<String,Object>> startSession() {
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE,
                "rb_session=fixture-cookie-marker; Path=/probe/session; HttpOnly",
                "rb_secondary=fixture-sibling-cookie; Path=/probe/session; HttpOnly")
                .body(Map.of("started", true));
    }
    @GetMapping("/probe/session/state")
    public ResponseEntity<Map<String,Object>> sessionState(@CookieValue(name="rb_session", defaultValue="") String session,
            @CookieValue(name="rb_secondary", defaultValue="") String secondary) {
        if (!session.equals("fixture-cookie-marker") || !secondary.equals("fixture-sibling-cookie")) {
            return ResponseEntity.status(401).body(Map.of("authenticated", false));
        }
        return ResponseEntity.ok(Map.of("people", testingState().get("people"), "echo", session));
    }
    @PostMapping("/probe/session/end")
    public ResponseEntity<Map<String,Object>> endSession() {
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE,
                "rb_session=; Max-Age=0; Path=/probe/session; HttpOnly",
                "rb_secondary=; Max-Age=0; Path=/probe/session; HttpOnly")
                .body(Map.of("ended", true));
    }
    @GetMapping("/probe") public Map<String,Object> probe() {
        Map<String,Object> result = service.probe();
        result.putAll(service.invalidQuery());
        return result;
    }
    @GetMapping("/probe/lazy-outside") public Map<String,Object> lazyOutside() { return service.lazyOutside(); }
    @GetMapping("/probe/sql") public List<String> sql() { return SqlCapture.snapshot(); }
    @GetMapping("/probe/runtime") public Map<String,Object> runtime() {
        return Map.of("boot",SpringBootVersion.getVersion(),"spring",SpringVersion.getVersion(),"hibernate",org.hibernate.Version.getVersionString(),
            "proxy",AopUtils.isAopProxy(service),"proxyType",service.getClass().getName(),"registered",context.getBean("registeredRuntimeThing").getClass().getName(),
            "factoryProduct",context.getBean("productFactory").getClass().getName(),"conditional",context.containsBean("conditionalRuntimeThing"));
    }
    @GetMapping("/probe/metamodel") public List<Map<String,Object>> metamodel() {
        List<Map<String,Object>> result = new ArrayList<>();
        for (var entity : emf.getMetamodel().getEntities()) {
            List<Map<String,Object>> attributes = new ArrayList<>();
            for (var attr : entity.getAttributes()) attributes.add(Map.of("name",attr.getName(),"kind",attr.getPersistentAttributeType().name(),"javaType",attr.getJavaType().getName(),"collection",attr.isCollection()));
            result.add(Map.of("name",entity.getName(),"javaType",entity.getJavaType().getName(),"attributes",attributes));
        }
        return result;
    }
}
