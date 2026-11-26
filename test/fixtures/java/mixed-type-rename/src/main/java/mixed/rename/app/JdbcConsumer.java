package mixed.rename.app;

import mixed.rename.domain.Invoice;
import mixed.rename.domain.InvoiceExtra;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import static mixed.rename.tool.InvoicesKt.makeInvoice;

public final class JdbcConsumer {
    public static void main(String[] args) {
        var jdbc = new JdbcTemplate(new DriverManagerDataSource(
            System.getenv("RB_KRENAME_JDBC_URL"), System.getenv("RB_KRENAME_JDBC_USER"),
            System.getenv("RB_KRENAME_JDBC_PASSWORD")));
        int amount = jdbc.queryForObject("SELECT 42", Integer.class);
        Invoice invoice = makeInvoice(amount);
        var qualified = new mixed.rename.domain.Invoice(amount);
        var extra = new InvoiceExtra("prefix retained");
        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" +
            invoice.render("bill:") + "/" + qualified.render("direct:") + "/" +
            extra.getLabel() + "/" + mixed.rename.shadow.Invoice.label());
    }
}
