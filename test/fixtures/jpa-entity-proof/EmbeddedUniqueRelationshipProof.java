import jakarta.persistence.EmbeddedId;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.JoinColumns;
import java.util.Collection;
import java.util.List;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;

public class EmbeddedUniqueRelationshipProof {
    public static void main(String[] args) throws Exception {
        Class<?> embeddedChild = Class.forName(args[0]);
        Class<?> embeddedParent = Class.forName(args[1]);
        Class<?> uniqueChild = Class.forName(args[2]);
        Class<?> uniqueParent = Class.forName(args[3]);
        Class<?> key = Class.forName(args[4]);
        require(embeddedParent.getDeclaredField("identity").isAnnotationPresent(EmbeddedId.class), "existing EmbeddedId remains");
        require(joinNames(embeddedChild).equals(List.of("tenant_id", "id")), "all EmbeddedId key columns are joined in order");
        require(joinNames(uniqueChild).equals(List.of("tenant_code", "account_code")), "all non-primary unique columns are joined in order");
        Object firstKey = key.getConstructor(Long.class, Long.class).newInstance(5L, 11L);
        Object secondKey = key.getConstructor(Long.class, Long.class).newInstance(6L, 11L);
        var registry = new StandardServiceRegistryBuilder()
            .applySetting("hibernate.hbm2ddl.auto", "none")
            .applySetting("hibernate.physical_naming_strategy", "org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl")
            .applySetting("jakarta.persistence.jdbc.url", System.getenv("RB_GENERATED_ENTITY_JDBC_URL"))
            .applySetting("jakarta.persistence.jdbc.user", System.getenv("RB_GENERATED_ENTITY_JDBC_USER"))
            .applySetting("jakarta.persistence.jdbc.password", System.getenv("RB_GENERATED_ENTITY_JDBC_PASSWORD"))
            .build();
        try {
            try (var factory = new MetadataSources(registry).addAnnotatedClass(embeddedChild).addAnnotatedClass(embeddedParent)
                    .addAnnotatedClass(uniqueChild).addAnnotatedClass(uniqueParent).buildMetadata().buildSessionFactory()) {
                try (var session = factory.openSession()) {
                    var transaction = session.beginTransaction();
                    Object first = session.find(embeddedParent, firstKey);
                    Object second = session.find(embeddedParent, secondKey);
                    Object child = session.find(embeddedChild, 21L);
                    require(call(child, embeddedChild, "getParentReference") == first, "embedded association resolves the exact tenant and id");
                    require(onlyChild(first, embeddedParent, child) && children(second, embeddedParent).isEmpty(),
                        "inverse embedded association uses both key components");

                    Object north = session.find(uniqueParent, 51L);
                    Object south = session.find(uniqueParent, 52L);
                    Object accountChild = session.find(uniqueChild, 61L);
                    Object target = call(accountChild, uniqueChild, "getParentReference");
                    require(Long.valueOf(51L).equals(factory.getPersistenceUnitUtil().getIdentifier(target)),
                        "alternate association resolves the exact tenant and account");
                    require(onlyChild(north, uniqueParent, accountChild) && children(south, uniqueParent).isEmpty(),
                        "inverse alternate association uses the complete unique tuple");

                    session.persist(newChild(embeddedChild, embeddedParent, 22L, second));
                    session.persist(newChild(uniqueChild, uniqueParent, 62L, south));
                    session.flush();
                    session.clear();

                    Object embeddedTarget = call(session.find(embeddedChild, 22L), embeddedChild, "getParentReference");
                    Object uniqueTarget = call(session.find(uniqueChild, 62L), uniqueChild, "getParentReference");
                    require(secondKey.equals(factory.getPersistenceUnitUtil().getIdentifier(embeddedTarget)), "EmbeddedId tuple is persisted");
                    require(Long.valueOf(52L).equals(factory.getPersistenceUnitUtil().getIdentifier(uniqueTarget)), "non-primary tuple is persisted");
                    transaction.rollback();
                }
                try (var session = factory.openSession()) {
                    require(session.find(embeddedChild, 22L) == null, "EmbeddedId association insert rolled back");
                    require(session.find(uniqueChild, 62L) == null, "alternate association insert rolled back");
                }
            }
        } finally {
            StandardServiceRegistryBuilder.destroy(registry);
        }
        System.out.println("ROCKETBRAIN_JPA_EMBEDDED_UNIQUE_JDBC_OK");
    }

    private static List<String> joinNames(Class<?> type) throws Exception {
        var joined = type.getDeclaredField("parentReference").getAnnotation(JoinColumns.class);
        return java.util.Arrays.stream(joined.value()).map(JoinColumn::referencedColumnName).toList();
    }

    private static Object newChild(Class<?> type, Class<?> parentType, Long id, Object parent) throws Exception {
        Object child = type.getConstructor().newInstance();
        type.getMethod("setId", Long.class).invoke(child, id);
        type.getMethod("setParentReference", parentType).invoke(child, parent);
        return child;
    }

    private static Object call(Object instance, Class<?> type, String getter) throws Exception {
        return type.getMethod(getter).invoke(instance);
    }

    private static Collection<?> children(Object parent, Class<?> type) throws Exception {
        return (Collection<?>) call(parent, type, "getChildren");
    }

    private static boolean onlyChild(Object parent, Class<?> type, Object child) throws Exception {
        var values = children(parent, type);
        return values.size() == 1 && values.iterator().next() == child;
    }

    private static void require(boolean found, String description) {
        if (!found) throw new AssertionError(description);
    }
}
