package fixture.boot;

import jakarta.persistence.EntityManager;

/** Source queries for the paired JPQL console fixture. The console runs the selections explicitly. */
final class HqlConsoleExamples {
    void examples(EntityManager em) {
        em.createQuery("with owners as (select p.id as id, p.displayName as name from Person p where p.id >= :minimum), retained as (select o.id as rid, o.name as label from owners o) select r.rid as seq, r.label as displayName from retained r where r.rid <= :ceiling order by r.rid");
        em.createQuery("select d.id as seq, d.name as displayName from (select p.id as id, p.displayName as name from Person p) d where d.id >= ?1 order by d.id");
        em.createQuery("select p.displayName as label from Person p where p.id >= :minimum union select d.name as label from Department d order by label");
        em.createQuery("select p.displayName as label from Person p where p.id >= :minimum union all select p.displayName as label from Person p where p.id >= :minimum");
        em.createQuery("select p.displayName as label from Person p where p.id >= :minimum intersect select p.displayName as label from Person p where p.id <= :maximum order by label");
        em.createQuery("select p.displayName as label from Person p where p.id >= :minimum except select p.displayName as label from Person p where p.id >= :excluded order by label");
        em.createQuery("with labels as (select p.displayName as label from Person p where p.id >= :minimum union select d.name as label from Department d) select l.label as label from labels l order by l.label");
    }
}
