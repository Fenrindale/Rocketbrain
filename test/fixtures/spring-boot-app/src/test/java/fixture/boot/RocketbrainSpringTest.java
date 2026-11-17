package fixture.boot;
import java.util.List;
import java.util.stream.Stream;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;
import static org.junit.jupiter.api.Assertions.*;
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.NONE,properties={"fixture.seed.enabled=false","spring.jpa.hibernate.ddl-auto=none","spring.jpa.open-in-view=false"})
class RocketbrainSpringTest {
    @Autowired EntityManager em;
    @Test @Transactional(readOnly=true) @DisplayName("실제 Spring 저장소와 DB 조회")
    void realRepository() {
        long actualCount=em.createQuery("select count(p) from Person p",Long.class).getSingleResult();
        // TEST_DEBUG_GATE: selected test has queried the real database before this assertion.
        assertEquals(2L,actualCount);
        assertEquals(List.of("Alex","Mina"),em.createQuery("select p.displayName from Person p order by p.id",String.class).getResultList());
    }
    @Test @Transactional @DisplayName("추가 행을 트랜잭션 종료 시 롤백")
    void rollbackWrite() {
        long before=em.createQuery("select count(d) from Department d",Long.class).getSingleResult();
        em.persist(new Department("Rolled-back test department"));em.flush();
        assertEquals(before+1,em.createQuery("select count(d) from Department d",Long.class).getSingleResult());
    }
    @ParameterizedTest(name="amount={0} -> {1}") @CsvSource({"0,normal","120,review"})
    void policy(int amount,String expected) {assertEquals(expected,new RiskPolicy().category(amount));}
    @TestFactory Stream<DynamicTest> dynamicPolicies() {
        return Stream.of(DynamicTest.dynamicTest("small amount",()->assertEquals("normal",new RiskPolicy().category(2))),DynamicTest.dynamicTest("large amount",()->assertEquals("review",new RiskPolicy().category(101))));
    }
    @Nested class NestedCases {
        @Test void nestedPolicy() {assertEquals("normal",new RiskPolicy().category(1));}
    }
    @Disabled("Deliberate skipped fixture; displayed as skipped") @Test void disabledCase() {fail("Must not run");}
}
