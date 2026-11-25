'use strict';

const names = {
  compound:'findTop3ByNameStartingWithIgnoreCaseAndScoreBetweenOrLocation_CityAndActiveTrueOrderByScoreDescNameAsc',
  page:'findByLocationCityAndScoreGreaterThanEqualOrderByNameAsc',
  explicit:'findByLocation_PostalCodeOrderByScoreDesc',
  ambiguous:'findByLocationPostalCode',
  orderOnly:'findByOrderByScoreDescNameAsc',
  in:'findByScoreInAndActiveTrueOrderByScoreDescNameAsc',
  allCase:'findByNameAndLocation_CityAllIgnoreCaseOrderByNameAsc',
  missing:'findByNameAndScoreBetween',
  extra:'findByScoreLessThan',
  unsupported:'findByNameRegex',
  mask:'findByLocationCode',
  reserved:'findById'
};

function derivedFixture(namespace,prefix,table) {
  const entity = prefix+'Account', location = prefix+'Location', postal = prefix+'Postal', repository = prefix+'Repository';
  const missing = prefix+'Missing', surplus = prefix+'Surplus';
  const file = (name,lines) => ({name,text:['package '+namespace+';',...lines,''].join('\n')});
  const files = [
    file(location,[
      'import jakarta.persistence.Embeddable;',
      '@Embeddable public class '+location+' {',
      '  String city;',
      '  String postalCode;',
      '  String code;',
      '  public '+location+'() {}',
      '  public '+location+'(String city, String postalCode) { this.city = city; this.postalCode = postalCode; }',
      '}'
    ]),
    file(postal,[
      'import jakarta.persistence.Embeddable;',
      'import jakarta.persistence.Column;',
      '@Embeddable public class '+postal+' {',
      '  @Column(name="office_code") String code;',
      '  public '+postal+'() {}',
      '  public '+postal+'(String code) { this.code = code; }',
      '}'
    ]),
    file(entity,[
      'import jakarta.persistence.*;',
      '@Entity @Table(name="'+table+'") public class '+entity+' {',
      '  @Id @Column(name="account_key") Long key;',
      '  String name;',
      '  int score;',
      '  boolean active;',
      '  @Embedded '+location+' location;',
      '  @Embedded '+postal+' locationPostal;',
      '  @Transient String locationCode;',
      '  public '+entity+'() {}',
      '  public '+entity+'(Long key, String name, int score, boolean active, String city, String post, String office) {',
      '    this.key = key; this.name = name; this.score = score; this.active = active;',
      '    this.location = new '+location+'(city, post); this.locationPostal = new '+postal+'(office);',
      '  }',
      '  public String label() { return name + ":" + score; }',
      '}'
    ]),
    file(repository,[
      'import java.util.*;',
      'import org.springframework.data.jpa.repository.JpaRepository;',
      'import org.springframework.data.domain.*;',
      'public interface '+repository+' extends JpaRepository<'+entity+',Long> {',
      '  List<'+entity+'> '+names.compound+'(String prefix, int floor, int ceiling, String city);',
      '  List<'+entity+'> '+names.page+'(String city, int floor, Pageable page);',
      '  List<'+entity+'> '+names.explicit+'(String code);',
      '  List<'+entity+'> '+names.ambiguous+'(String code);',
      '  List<'+entity+'> '+names.orderOnly+'();',
      '  List<'+entity+'> '+names.in+'(List<Integer> scores);',
      '  List<'+entity+'> '+names.allCase+'(String name, String city);',
      '  default String findByScore(String label) { return label; }',
      '}'
    ]),
    file(missing,[
      'import java.util.List;',
      'public interface '+missing+' extends org.springframework.data.jpa.repository.JpaRepository<'+entity+',Long> {',
      '  List<'+entity+'> '+names.missing+'(String name, int floor);',
      '}'
    ]),
    file(prefix+'Diagnostics',[
      'import java.util.List;',
      'import org.springframework.data.jpa.repository.JpaRepository;',
      'public interface '+prefix+'Diagnostics extends JpaRepository<'+entity+',Long> {',
      '  List<'+entity+'> '+names.unsupported+'(String value);',
      '  List<'+entity+'> '+names.mask+'(String value);',
      '}'
    ]),
    file(surplus,[
      'import java.util.*;',
      'import org.springframework.data.jpa.repository.*;',
      'public interface '+surplus+' extends JpaRepository<'+entity+',Long> {',
      '  List<'+entity+'> '+names.extra+'(int score, String unused);',
      '  Optional<'+entity+'> '+names.reserved+'(Long key);',
      '}'
    ])
  ];
  return {files,entity,location,postal,repository,missing,surplus,names,namespace,table};
}

function runtimeSource(fixture) {
  const { namespace,entity,repository,missing,surplus } = fixture;
  return [
    'package '+namespace+';',
    'import java.util.List;',
    'import java.util.stream.Collectors;',
    'import org.hibernate.cfg.Configuration;',
    'import org.springframework.data.domain.PageRequest;',
    'import org.springframework.data.jpa.repository.support.JpaRepositoryFactory;',
    'import org.springframework.data.repository.query.parser.PartTree;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class DerivedRuntime {',
    '  static String rows(List<'+entity+'> rows) { return rows.stream().map('+entity+'::label).collect(Collectors.joining(",")); }',
    '  static void receipt(String key, String value) { System.out.println("RB_DERIVED|" + key + "|" + value); }',
    '  static String parts(PartTree tree) {',
    '    return tree.stream().map(group -> group.stream().map(part -> part.getProperty().toDotPath() + ":" +',
    '      part.getType().name() + ":" + part.getNumberOfArguments() + ":" + part.shouldIgnoreCase().name()).collect(Collectors.joining(",")))',
    '      .collect(Collectors.joining(";"));',
    '  }',
    '  static boolean rejected(Runnable use, String evidence) {',
    '    try { use.run(); return false; } catch (RuntimeException failure) {',
    '      for (Throwable cause = failure; cause != null; cause = cause.getCause())',
    '        if (String.valueOf(cause.getMessage()).contains(evidence)) return true;',
    '      throw failure;',
    '    }',
    '  }',
    '  public static void main(String[] args) {',
    '    var connection = new DriverManagerDataSource(System.getenv("RB_DERIVED_JDBC_URL"),',
    '      System.getenv("RB_DERIVED_JDBC_USER"), System.getenv("RB_DERIVED_JDBC_PASSWORD"));',
    '    var configuration = new Configuration().addAnnotatedClass('+entity+'.class);',
    '    configuration.getProperties().put("hibernate.connection.datasource", connection);',
    '    configuration.setProperty("hibernate.hbm2ddl.auto", "create-drop");',
    '    try (var factory = configuration.buildSessionFactory(); var manager = factory.createEntityManager()) {',
    '      var repositories = new JpaRepositoryFactory(manager);',
    '      var repo = repositories.getRepository('+repository+'.class);',
    '      manager.getTransaction().begin();',
    '      repo.saveAll(List.of(',
    '        new '+entity+'(1L,"Alice",42,true,"Vienna","A","O1"),',
    '        new '+entity+'(2L,"Albert",17,false,"Paris","A","O2"),',
    '        new '+entity+'(3L,"Bob",70,true,"Oslo","B","A"),',
    '        new '+entity+'(4L,"Carla",80,false,"Oslo","C","O4"),',
    '        new '+entity+'(5L,"Alicia",35,true,"Paris","A","O5"),',
    '        new '+entity+'(6L,"Aaron",35,true,"Paris","D","O6")));',
    '      manager.getTransaction().commit();',
    '      manager.clear();',
    '      receipt("server",new JdbcTemplate(connection).queryForObject("SELECT VERSION()", String.class));',
    '      var compound = new PartTree("'+names.compound+'", '+entity+'.class);',
    '      receipt("parts",parts(compound));',
    '      receipt("order",compound.getSort().stream().map(item -> item.getProperty() + ":" + item.getDirection().name()).collect(Collectors.joining(",")));',
    '      receipt("limit",String.valueOf(compound.getMaxResults()));',
    '      receipt("implicit",new PartTree("'+names.page+'", '+entity+'.class).getParts().iterator().next().getProperty().toDotPath());',
    '      receipt("greedy",new PartTree("'+names.ambiguous+'", '+entity+'.class).getParts().iterator().next().getProperty().toDotPath());',
    '      receipt("compound",rows(repo.'+names.compound+'("a",10,40,"Oslo")));',
    '      receipt("page",rows(repo.'+names.page+'("Paris",20,PageRequest.of(0,1))));',
    '      receipt("explicit",rows(repo.'+names.explicit+'("A")));',
    '      receipt("greedyRows",rows(repo.'+names.ambiguous+'("A")));',
    '      receipt("orderOnly",rows(repo.'+names.orderOnly+'()));',
    '      receipt("in",rows(repo.'+names.in+'(List.of(35,70))));',
    '      receipt("allCase",rows(repo.'+names.allCase+'("alicia","PARIS")));',
    '      receipt("missing",String.valueOf(rejected(() -> repositories.getRepository('+missing+'.class), "only found 2")));',
    '      var extra = repositories.getRepository('+surplus+'.class);',
    '      receipt("surplus",rows(extra.'+names.extra+'(20,"unused")));',
    '    }',
    '  }',
    '}', ''
  ].join('\n');
}

module.exports = {derivedFixture,runtimeSource};
