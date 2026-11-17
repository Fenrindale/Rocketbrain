package fixture.boot;
import java.util.List;
import jakarta.persistence.EntityManager;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.testng.AbstractTestNGSpringContextTests;
import org.springframework.transaction.annotation.Transactional;
import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;
import static org.testng.Assert.*;
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.NONE,properties={"fixture.seed.enabled=false","spring.jpa.hibernate.ddl-auto=none","spring.jpa.open-in-view=false"})
@Transactional
public class RocketbrainTestNGTest extends AbstractTestNGSpringContextTests {
    @Autowired EntityManager em;
    @Test public void realRepository() {
        long actualCount=em.createQuery("select count(p) from Person p",Long.class).getSingleResult();
        // TESTNG_DEBUG_GATE: the managed TestNG JVM has queried the real server.
        assertEquals(actualCount,2L);
        assertEquals(em.createQuery("select p.displayName from Person p order by p.id",String.class).getResultList(),List.of("Alex","Mina"));
    }
    @Test public void rollbackWrite() {
        long before=em.createQuery("select count(d) from Department d",Long.class).getSingleResult();
        em.persist(new Department("Rolled-back test department"));em.flush();
        assertEquals(em.createQuery("select count(d) from Department d",Long.class).getSingleResult().longValue(),before+1);
    }
    @DataProvider(name="amounts") public Object[][] amounts(){return new Object[][]{{0,"normal"},{120,"review"}};}
    @Test(dataProvider="amounts") public void amountPolicy(int amount,String expected){assertEquals(new RiskPolicy().category(amount),expected);}
    @Test(enabled=false) public void disabledCase(){fail("Must not run");}
}
