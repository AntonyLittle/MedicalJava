package com.medicaljava.volumerestservice.store;

import com.zaxxer.hikari.HikariDataSource;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

@Configuration
public class StoreConfig {

    @Bean
    StorePaths storePaths(@Value("${app.store-dir:store}") String storeDir) throws IOException {
        var root = Path.of(storeDir).toAbsolutePath().normalize();
        var paths = new StorePaths(root, root.resolve("store.db"), root.resolve("volumes"), root.resolve("tmp"));
        Files.createDirectories(paths.volumes());
        Files.createDirectories(paths.tmp());
        return paths;
    }

    @Bean(destroyMethod = "close")
    DataSource dataSource(StorePaths paths) {
        var ds = new HikariDataSource();
        ds.setPoolName("volume-store");
        ds.setJdbcUrl("jdbc:sqlite:" + paths.database());
        // sqlite-jdbc applies these pragmas to every new connection.
        ds.addDataSourceProperty("foreign_keys", "true");
        ds.addDataSourceProperty("journal_mode", "WAL");
        ds.addDataSourceProperty("synchronous", "NORMAL");
        ds.addDataSourceProperty("busy_timeout", "5000");
        ds.setMaximumPoolSize(4);
        return ds;
    }
}
