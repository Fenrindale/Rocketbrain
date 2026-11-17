package fixture.boot;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Bean;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import jakarta.persistence.EntityManager;
@Configuration
public class SeedConfiguration {
    public static volatile boolean ready;
    @Bean @ConditionalOnProperty(name="fixture.seed.enabled",havingValue="true",matchIfMissing=true)
    CommandLineRunner seed(EntityManager em, PlatformTransactionManager manager) {
        return args -> {
            new TransactionTemplate(manager).execute(status -> {
                Department team = new Department("Engineering"); em.persist(team);
                em.persist(new Person("Alex",new Address("Seoul","01234"),team));
                em.persist(new Person("Mina",new Address("Busan","54321"),team));
                em.persist(new DocumentAsset("Runbook","PDF"));
                em.persist(new PropertyRecord("EXT-01"));
                em.persist(new CustomRecord(team));
                Region region=new Region(new RegionId("KR","ICN"),"Harbor");em.persist(region);
                em.persist(new Warehouse("Incheon store",region));
                em.persist(new License("TENANT","PRO","Licensed fixture"));
                em.persist(new Truck("Delivery truck",1200));
                em.persist(new CashPayment(700L,new java.math.BigDecimal("12.50"),"Till-A"));
                em.persist(new XmlRecord("XML label"));
                em.persist(new XmlOverrideRecord("XML overrides annotations"));
                return null;
            });
            ready=true;
        };
    }
}
