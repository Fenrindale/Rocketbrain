import java.util.List;
import java.util.Set;

import jakarta.persistence.JoinTable;
import jakarta.persistence.ManyToMany;
import jakarta.persistence.OneToMany;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;

public class GeneratedCollectionRelationshipProof {
    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        Class<?> owner = Class.forName(args[0]);
        Class<?> child = Class.forName(args[1]);
        Class<?> tag = Class.forName(args[2]);
        Class<?> key = tag.getAnnotation(jakarta.persistence.IdClass.class).value();
        var firstKey = key.getConstructor(Integer.class, Long.class).newInstance(17, 8100000001L);
        var nextKey = key.getConstructor(Integer.class, Long.class).newInstance(18, 8100000002L);
        var members = owner.getDeclaredField("members").getAnnotation(OneToMany.class);
        require(members.mappedBy().equals("ownerReference") && members.cascade().length == 0 && !members.orphanRemoval(), "exact inverse metadata");
        var tagField = owner.getDeclaredField("tags");
        var join = tagField.getAnnotation(JoinTable.class);
        require(tagField.isAnnotationPresent(ManyToMany.class) && join.joinColumns().length == 1 && join.inverseJoinColumns().length == 2,
            "explicit many-to-many FK roles");

        String url = System.getenv("RB_GENERATED_ENTITY_JDBC_URL");
        var configuration = new StandardServiceRegistryBuilder().applySetting("hibernate.hbm2ddl.auto", "none")
            .applySetting("hibernate.physical_naming_strategy", "org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl");
        if (url == null) {
            configuration.applySetting("hibernate.dialect", "org.hibernate.dialect.MySQLDialect");
            configuration.applySetting("hibernate.boot.allow_jdbc_metadata_access", "false");
        } else {
            configuration.applySetting("jakarta.persistence.jdbc.url", url);
            configuration.applySetting("jakarta.persistence.jdbc.user", System.getenv("RB_GENERATED_ENTITY_JDBC_USER"));
            configuration.applySetting("jakarta.persistence.jdbc.password", System.getenv("RB_GENERATED_ENTITY_JDBC_PASSWORD"));
        }
        var registry = configuration.build();
        try {
            try (var factory = new MetadataSources(registry).addAnnotatedClass(owner).addAnnotatedClass(child)
                    .addAnnotatedClass(tag).buildMetadata().buildSessionFactory()) {
                if (url != null) {
                    try (var session = factory.openSession()) {
                        var transaction = session.beginTransaction();
                        Object club = session.find(owner, 71L);
                        var inverseMembers = (List<Object>) owner.getMethod("getMembers").invoke(club);
                        require(inverseMembers.size() == 2, "two children from the inverse collection");
                        for (Object member : inverseMembers) {
                            var owningReference = child.getMethod("getOwnerReference").invoke(member);
                            require(owner.getMethod("getId").invoke(owningReference).equals(71L), "owning member points back to the parent");
                        }
                        Object firstTag = session.find(tag, firstKey);
                        Object additional = session.find(tag, nextKey);
                        var links = (Set<Object>) owner.getMethod("getTags").invoke(club);
                        require(links.size() == 1 && links.contains(firstTag), "composite role readback");
                        require(links.add(additional), "second many-to-many link");
                        session.flush();
                        session.clear();
                        club = session.find(owner, 71L);
                        require(((Set<?>) owner.getMethod("getTags").invoke(club)).size() == 2, "join table insert readback");
                        transaction.rollback();
                    }
                    try (var session = factory.openSession()) {
                        Object club = session.find(owner, 71L);
                        require(((Set<?>) owner.getMethod("getTags").invoke(club)).size() == 1, "join table rollback");
                    }
                }
            }
        } finally {
            StandardServiceRegistryBuilder.destroy(registry);
        }
        System.out.println(url == null ? "ROCKETBRAIN_JPA_COLLECTION_BIND_OK" : "ROCKETBRAIN_JPA_COLLECTION_JDBC_OK");
    }

    private static void require(boolean found, String reason) {
        if (!found) throw new AssertionError(reason);
    }
}
